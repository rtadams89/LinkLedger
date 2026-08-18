"""CSV export/import for the three data tables (devices, ports, cables) plus
the Sites list and the enabled-roles/enabled-speeds picker settings, and the
"Backup"/"Restore" zip bundle built on top of all five (see
build_backup_zip / restore_backup_zip at the bottom of this file) -- that
zip is what the Settings page's Backup/Restore buttons actually use.

The CSVs reference devices/ports by NAME rather than raw database id, on
purpose -- it makes them hand-editable in a spreadsheet, and it means
export -> edit -> import round-trips cleanly even though ids get
reassigned on import.

A couple of things worth knowing about the replace semantics:
- Replacing devices also replaces ports, cables, and LAGs -- none of those
  can exist without the device they're on, so the database enforces this
  via cascading deletes regardless of what this module does.
- Replacing ports also replaces cables and clears LAG membership, for the
  same reason (a cable/LAG can't point at a port that no longer exists).
  The ports CSV's own `lag` column repopulates LAG membership as part of
  the same import; re-import a cables CSV afterward if you need to
  restore those connections too.
- Replacing cables only replaces cables; devices and ports are untouched.
- Replacing sites replaces the whole managed Sites list (not a merge) --
  same "replace, don't merge" rule as everything else here. It does NOT
  touch devices.site on any existing device (that's still just free text,
  same as always -- see crud.py's Sites section), so this can never blank
  a device's site even if the restored list doesn't happen to include it.
- Replacing roles/speeds replaces the whole enabled set for that picker
  (there's only ever one such set, so "replace" and "merge" mean the same
  thing here) -- same non-destructive contract as the Settings page
  checkboxes: this only changes what's offered for new picks, never what's
  already saved on a device/port.
- A Restore applies whichever of devices/ports/cables/sites/roles/speeds it
  finds inside the zip. devices/ports/cables always apply in that
  dependency order regardless of the order the files appear in the zip --
  otherwise, e.g., importing ports.csv after devices.csv would be fine,
  but importing them in the reverse order would have the devices import's
  cascade wipe out the ports that were just restored. sites/roles/speeds
  have no such dependency (on the other data or on each other), so their
  relative order doesn't matter.
"""

import csv
import io
import json
import zipfile
from datetime import datetime, timezone

from . import crud, db

DEVICE_COLUMNS = ["name", "role", "model", "site", "notes", "poe_required"]
# wireless_link/uplink_for are new in v1.6.0 (AP Group / Virtual Switch
# support); lag is new in v1.7.0 (LAG / bonded-link support). All three are
# appended at the end and NOT required for detection (see _SCHEMAS below),
# so a ports CSV exported before this version still re-imports cleanly
# with the new columns simply blank for every row.
PORT_COLUMNS = ["device_name", "port_name", "speed", "vlans", "poe_supply", "pair_with",
                "wireless_link", "uplink_for", "lag"]
CABLE_COLUMNS = ["device_a", "port_a", "device_b", "port_b", "label"]
SITE_COLUMNS = ["name"]
ROLE_COLUMNS = ["role"]    # one row per currently-ENABLED role (see crud.get_enabled_roles)
SPEED_COLUMNS = ["speed"]  # one row per currently-ENABLED speed (see crud.get_enabled_speeds)

# Used to auto-detect which type an uploaded CSV is, from its header row --
# deliberately just the columns a ports CSV has ALWAYS had, so older
# exports (without wireless_link/uplink_for) still detect correctly. The
# single-column schemas (sites/roles/speeds) can't collide with devices/
# ports/cables -- none of those has a bare "name"/"role"/"speed" as its
# ENTIRE required column set.
_SCHEMAS = {
    "devices": set(DEVICE_COLUMNS),
    "ports": {"device_name", "port_name", "speed", "vlans", "poe_supply", "pair_with"},
    "cables": set(CABLE_COLUMNS),
    "sites": set(SITE_COLUMNS),
    "roles": set(ROLE_COLUMNS),
    "speeds": set(SPEED_COLUMNS),
}


def _yesno(v) -> bool:
    return str(v or "").strip().lower() in ("yes", "y", "true", "1")


def _bool_cell(v) -> str:
    return "yes" if v else "no"


# ---------------------------------------------------------------------------
# Export
# ---------------------------------------------------------------------------

def export_csv(conn, kind: str) -> bytes:
    if kind == "devices":
        return _export_devices(conn)
    if kind == "ports":
        return _export_ports(conn)
    if kind == "cables":
        return _export_cables(conn)
    if kind == "sites":
        return _export_sites(conn)
    if kind == "roles":
        return _export_roles(conn)
    if kind == "speeds":
        return _export_speeds(conn)
    raise ValueError(f"unknown export kind: {kind!r}")


def _export_devices(conn) -> bytes:
    out = io.StringIO()
    w = csv.writer(out)
    w.writerow(DEVICE_COLUMNS)
    for d in crud.list_devices(conn):
        w.writerow([d["name"], d["role"], d["model"], d["site"], d["notes"], _bool_cell(d["poe_required"])])
    return out.getvalue().encode("utf-8")


def _export_ports(conn) -> bytes:
    devices = crud.list_devices(conn)
    device_by_id = {d["id"]: d for d in devices}
    all_ports = []
    port_lookup = {}  # port_id -> (device_name, port_name)
    for d in devices:
        for p in crud.list_ports(conn, d["id"]):
            p["device_name"] = d["name"]
            all_ports.append(p)
            port_lookup[p["id"]] = (d["name"], p["name"])

    # port_id -> name of the AP Group / Virtual Switch it's an uplink for
    uplink_for = {
        row["port_id"]: row["vs_name"]
        for row in conn.execute(
            "SELECT u.port_id, d.name AS vs_name FROM virtual_switch_uplinks u "
            "JOIN devices d ON d.id = u.virtual_switch_id"
        ).fetchall()
    }
    # port_id -> name of the LAG (on the same device) it's a member of
    lag_name = {
        row["id"]: row["lag_name"]
        for row in conn.execute(
            "SELECT ports.id, lags.name AS lag_name FROM ports JOIN lags ON lags.id = ports.lag_id"
        ).fetchall()
    }

    out = io.StringIO()
    w = csv.writer(out)
    w.writerow(PORT_COLUMNS)
    for p in all_ports:
        pair_with = ""
        if p["pair_port_id"] and p["pair_port_id"] in port_lookup:
            pair_with = port_lookup[p["pair_port_id"]][1]
        wireless_link = ""
        if p["virtual_switch_id"] and p["virtual_switch_id"] in device_by_id:
            wireless_link = device_by_id[p["virtual_switch_id"]]["name"]
        w.writerow([p["device_name"], p["name"], p["speed"], p["vlans"], _bool_cell(p["poe_supply"]),
                    pair_with, wireless_link, uplink_for.get(p["id"], ""), lag_name.get(p["id"], "")])
    return out.getvalue().encode("utf-8")


def _export_cables(conn) -> bytes:
    out = io.StringIO()
    w = csv.writer(out)
    w.writerow(CABLE_COLUMNS)
    for c in crud.list_cables(conn):
        w.writerow([c["a_device_name"], c["a_port_name"], c["b_device_name"], c["b_port_name"], c["label"]])
    return out.getvalue().encode("utf-8")


def _export_sites(conn) -> bytes:
    out = io.StringIO()
    w = csv.writer(out)
    w.writerow(SITE_COLUMNS)
    for s in crud.list_sites(conn):
        w.writerow([s["name"]])
    return out.getvalue().encode("utf-8")


def _export_roles(conn) -> bytes:
    out = io.StringIO()
    w = csv.writer(out)
    w.writerow(ROLE_COLUMNS)
    for role in crud.get_enabled_roles(conn):
        w.writerow([role])
    return out.getvalue().encode("utf-8")


def _export_speeds(conn) -> bytes:
    out = io.StringIO()
    w = csv.writer(out)
    w.writerow(SPEED_COLUMNS)
    for speed in crud.get_enabled_speeds(conn):
        w.writerow([speed])
    return out.getvalue().encode("utf-8")


# ---------------------------------------------------------------------------
# Import
# ---------------------------------------------------------------------------

def _detect_kind(header_fields):
    header_set = {f.strip() for f in (header_fields or []) if f and f.strip()}
    for kind, schema in _SCHEMAS.items():
        if schema <= header_set:  # every required column is present (extra columns are tolerated)
            return kind
    return None


def _raise_validation(errors):
    preview = "; ".join(errors[:8])
    more = f" (+{len(errors) - 8} more)" if len(errors) > 8 else ""
    raise crud.ConflictError(f"import validation failed: {preview}{more}")


def import_csv(conn, data: bytes) -> dict:
    """Validates the CSV BEFORE touching the database -- either the whole
    import applies or nothing does. Detects devices/ports/cables/sites/
    roles/speeds from the header row and replaces only that one."""
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError:
        raise crud.ConflictError("that doesn't look like a valid CSV (text) file")

    reader = csv.DictReader(io.StringIO(text))
    if not reader.fieldnames:
        raise crud.ConflictError("the CSV file is empty")

    kind = _detect_kind(reader.fieldnames)
    if kind is None:
        raise crud.ConflictError(
            "unrecognized CSV columns -- expected a devices, ports, cables, sites, roles, "
            "or speeds export from LinkLedger (see Help for the exact column names)"
        )
    rows = list(reader)

    if kind == "devices":
        _import_devices(conn, rows)
    elif kind == "ports":
        _import_ports(conn, rows)
    elif kind == "cables":
        _import_cables(conn, rows)
    elif kind == "sites":
        _import_sites(conn, rows)
    elif kind == "roles":
        _import_roles(conn, rows)
    else:
        _import_speeds(conn, rows)

    return {"type": kind, "count": len(rows)}


def _import_devices(conn, rows):
    errors = []
    names = set()
    for i, row in enumerate(rows, start=2):
        name = (row.get("name") or "").strip()
        if not name:
            errors.append(f"row {i}: missing name")
            continue
        if name in names:
            errors.append(f"row {i}: duplicate device name '{name}'")
        names.add(name)
    if errors:
        _raise_validation(errors)

    # Devices can't exist without... themselves, but ports/cables can't
    # exist without the devices they're on -- cascading deletes handle
    # that automatically once the devices are gone.
    conn.execute("DELETE FROM cables")
    conn.execute("DELETE FROM ports")
    conn.execute("DELETE FROM devices")
    for row in rows:
        conn.execute(
            "INSERT INTO devices (name, role, model, site, notes, poe_required) VALUES (?, ?, ?, ?, ?, ?)",
            (row["name"].strip(), (row.get("role") or "").strip(), (row.get("model") or "").strip(),
             (row.get("site") or "").strip(), (row.get("notes") or "").strip(),
             int(_yesno(row.get("poe_required")))),
        )


def _import_ports(conn, rows):
    device_roles = {row["name"]: row["role"] for row in conn.execute("SELECT name, role FROM devices").fetchall()}
    device_names = set(device_roles)

    errors = []
    port_keys = set()
    for i, row in enumerate(rows, start=2):
        dname = (row.get("device_name") or "").strip()
        pname = (row.get("port_name") or "").strip()
        if not dname or not pname:
            errors.append(f"row {i}: missing device_name or port_name")
            continue
        if dname not in device_names:
            errors.append(f"row {i}: device '{dname}' not found -- add it first (or import a devices CSV)")
            continue
        key = (dname, pname)
        if key in port_keys:
            errors.append(f"row {i}: duplicate port '{pname}' on device '{dname}'")
        port_keys.add(key)
        speed = (row.get("speed") or "").strip()
        if speed and speed not in crud.SPEED_MBPS:
            errors.append(f"row {i}: unrecognized speed '{speed}'")

    for i, row in enumerate(rows, start=2):
        dname = (row.get("device_name") or "").strip()
        pair_with = (row.get("pair_with") or "").strip()
        wireless_link = (row.get("wireless_link") or "").strip()
        uplink_for = (row.get("uplink_for") or "").strip()
        if pair_with and (dname, pair_with) not in port_keys:
            errors.append(f"row {i}: pair_with '{pair_with}' not found on device '{dname}'")
        if wireless_link and pair_with:
            errors.append(f"row {i}: a port can't have both pair_with and wireless_link")
        for label, name in (("wireless_link", wireless_link), ("uplink_for", uplink_for)):
            if not name:
                continue
            if name not in device_roles:
                errors.append(f"row {i}: {label} '{name}' not found -- add it first (or import a devices CSV)")
            elif device_roles[name] not in crud.db.VIRTUAL_SWITCH_ROLES:
                errors.append(f"row {i}: {label} '{name}' isn't an AP Group or Virtual Switch device")

    if errors:
        _raise_validation(errors)

    # Cables can't point at ports that no longer exist, so replacing ports
    # necessarily clears cables too -- re-import a cables CSV afterward to
    # restore connections if needed. Any virtual_switch_uplinks rows for
    # replaced ports cascade-delete automatically along with the ports.
    # LAGs don't cascade-delete this way (a lag belongs to the device, not
    # to any one port), but every existing lag's members are about to
    # vanish anyway, so clear them out too -- re-populate via this same
    # ports CSV's `lag` column, which the pass below does automatically.
    conn.execute("DELETE FROM cables")
    conn.execute("DELETE FROM ports")
    conn.execute("DELETE FROM lags")

    device_ids = {row["name"]: row["id"] for row in conn.execute("SELECT id, name FROM devices").fetchall()}
    port_ids = {}
    for row in rows:
        dname, pname = row["device_name"].strip(), row["port_name"].strip()
        cur = conn.execute(
            "INSERT INTO ports (device_id, name, speed, vlans, poe_supply) VALUES (?, ?, ?, ?, ?)",
            (device_ids[dname], pname, (row.get("speed") or "").strip(), (row.get("vlans") or "").strip(),
             int(_yesno(row.get("poe_supply")))),
        )
        port_ids[(dname, pname)] = cur.lastrowid

    for row in rows:
        pair_with = (row.get("pair_with") or "").strip()
        if not pair_with:
            continue
        dname, pname = row["device_name"].strip(), row["port_name"].strip()
        a, b = port_ids[(dname, pname)], port_ids[(dname, pair_with)]
        conn.execute("UPDATE ports SET pair_port_id = ? WHERE id = ?", (b, a))
        conn.execute("UPDATE ports SET pair_port_id = ? WHERE id = ? AND pair_port_id IS NULL", (a, b))

    for row in rows:
        wireless_link = (row.get("wireless_link") or "").strip()
        if not wireless_link:
            continue
        dname, pname = row["device_name"].strip(), row["port_name"].strip()
        conn.execute("UPDATE ports SET virtual_switch_id = ? WHERE id = ?",
                      (device_ids[wireless_link], port_ids[(dname, pname)]))

    for row in rows:
        uplink_for = (row.get("uplink_for") or "").strip()
        if not uplink_for:
            continue
        dname, pname = row["device_name"].strip(), row["port_name"].strip()
        conn.execute("INSERT INTO virtual_switch_uplinks (virtual_switch_id, port_id) VALUES (?, ?)",
                      (device_ids[uplink_for], port_ids[(dname, pname)]))

    # LAG membership -- a lag name is scoped to its device, so two devices
    # can each have their own "LAG1" without clashing. Created on the fly
    # (no need to pre-declare it anywhere in the file).
    lag_ids = {}  # (device_name, lag_name) -> lag_id
    for row in rows:
        lag_name = (row.get("lag") or "").strip()
        if not lag_name:
            continue
        dname, pname = row["device_name"].strip(), row["port_name"].strip()
        key = (dname, lag_name)
        if key not in lag_ids:
            cur = conn.execute("INSERT INTO lags (device_id, name) VALUES (?, ?)", (device_ids[dname], lag_name))
            lag_ids[key] = cur.lastrowid
        conn.execute("UPDATE ports SET lag_id = ? WHERE id = ?", (lag_ids[key], port_ids[(dname, pname)]))


def _import_cables(conn, rows):
    port_rows = conn.execute(
        "SELECT ports.id, ports.name AS port_name, devices.name AS device_name FROM ports "
        "JOIN devices ON devices.id = ports.device_id"
    ).fetchall()
    port_ids = {(r["device_name"], r["port_name"]): r["id"] for r in port_rows}

    errors = []
    for i, row in enumerate(rows, start=2):
        da, pa = (row.get("device_a") or "").strip(), (row.get("port_a") or "").strip()
        db_, pb = (row.get("device_b") or "").strip(), (row.get("port_b") or "").strip()
        if not all([da, pa, db_, pb]):
            errors.append(f"row {i}: missing device/port reference")
            continue
        if (da, pa) not in port_ids:
            errors.append(f"row {i}: port '{pa}' on device '{da}' not found")
        if (db_, pb) not in port_ids:
            errors.append(f"row {i}: port '{pb}' on device '{db_}' not found")
        if da == db_ and pa == pb:
            errors.append(f"row {i}: a port can't be cabled to itself")
    if errors:
        _raise_validation(errors)

    conn.execute("DELETE FROM cables")
    for row in rows:
        a = port_ids[(row["device_a"].strip(), row["port_a"].strip())]
        b = port_ids[(row["device_b"].strip(), row["port_b"].strip())]
        conn.execute(
            "INSERT INTO cables (port_a_id, port_b_id, label) VALUES (?, ?, ?)",
            (a, b, (row.get("label") or "").strip()),
        )


def _import_sites(conn, rows):
    """Replaces the whole managed Sites list. Does NOT touch devices.site on
    any existing device -- that stays free text either way (see crud.py's
    Sites section), so this can never blank a device even if the restored
    list doesn't happen to include whatever it's currently set to."""
    errors = []
    names = set()
    for i, row in enumerate(rows, start=2):
        name = (row.get("name") or "").strip()
        if not name:
            errors.append(f"row {i}: missing name")
            continue
        if name in names:
            errors.append(f"row {i}: duplicate site '{name}'")
        names.add(name)
    if errors:
        _raise_validation(errors)

    conn.execute("DELETE FROM sites")
    for row in rows:
        conn.execute("INSERT INTO sites (name) VALUES (?)", (row["name"].strip(),))


def _import_roles(conn, rows):
    """Replaces the enabled-roles picker setting outright -- there's only
    ever one such set, so "replace" and "merge" mean the same thing here.
    Doesn't touch any device's own role value (see crud.get_enabled_roles)."""
    errors = []
    roles = []
    for i, row in enumerate(rows, start=2):
        role = (row.get("role") or "").strip()
        if not role:
            errors.append(f"row {i}: missing role")
            continue
        if role not in db.ROLES:
            errors.append(f"row {i}: unrecognized role '{role}'")
            continue
        roles.append(role)
    if errors:
        _raise_validation(errors)
    crud.set_enabled_roles(conn, roles)


def _import_speeds(conn, rows):
    """Replaces the enabled-speeds picker setting outright, same story as
    _import_roles above. Doesn't touch any port's own speed value."""
    errors = []
    speeds = []
    for i, row in enumerate(rows, start=2):
        speed = (row.get("speed") or "").strip()
        if not speed:
            errors.append(f"row {i}: missing speed")
            continue
        if speed not in crud.SPEED_MBPS:
            errors.append(f"row {i}: unrecognized speed '{speed}'")
            continue
        speeds.append(speed)
    if errors:
        _raise_validation(errors)
    crud.set_enabled_speeds(conn, speeds)


# ---------------------------------------------------------------------------
# Backup / Restore -- a single .zip bundling all six CSVs plus a small
# metadata file, instead of asking someone to export/import each type as a
# separate round trip.
# ---------------------------------------------------------------------------

BACKUP_INFO_FILENAME = "backup-info.json"


def build_backup_zip(conn, version: str) -> tuple[bytes, str]:
    """Builds the Backup .zip: devices.csv, ports.csv, cables.csv, sites.csv,
    roles.csv, speeds.csv, and a backup-info.json noting when the backup was
    made and which LinkLedger version made it. roles.csv/speeds.csv capture
    the enabled-picker settings (Settings -> Device roles / Interface
    speeds), not the fixed underlying lists. Returns (zip_bytes, created_at)
    -- the caller uses created_at to name the downloaded file."""
    created_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    info = {"linkledger_version": version, "created_at": created_at}

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("devices.csv", export_csv(conn, "devices"))
        zf.writestr("ports.csv", export_csv(conn, "ports"))
        zf.writestr("cables.csv", export_csv(conn, "cables"))
        zf.writestr("sites.csv", export_csv(conn, "sites"))
        zf.writestr("roles.csv", export_csv(conn, "roles"))
        zf.writestr("speeds.csv", export_csv(conn, "speeds"))
        zf.writestr(BACKUP_INFO_FILENAME, json.dumps(info, indent=2) + "\n")
    return buf.getvalue(), created_at


def restore_backup_zip(conn, data: bytes) -> dict:
    """Restores a Backup .zip (see build_backup_zip) -- or really any zip
    containing one or more of devices.csv/ports.csv/cables.csv/sites.csv/
    roles.csv/speeds.csv (by column header, not filename, same detection as
    a single-CSV import), so a backup trimmed down to just the file(s) you
    changed still works. Applies whichever types it finds -- devices/ports/
    cables always in that dependency order regardless of what order they
    appear in the zip (see the module docstring for why); sites/roles/
    speeds have no dependency on those or each other, so they're applied
    afterward in a fixed but otherwise arbitrary order. Non-CSV members
    (backup-info.json, thumbnails from an unzip-then-rezip, whatever) and
    CSVs that don't match a known column schema are silently ignored.
    Raises ConflictError if nothing usable is found, or if any of the CSVs
    found fails validation -- the whole restore shares one connection/
    transaction, so if e.g. the cables CSV fails after devices and ports
    already applied, none of it is committed, not even the parts that
    individually would have been fine."""
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        raise crud.ConflictError("that doesn't look like a valid backup .zip file")

    detected = {}  # kind -> csv bytes; last match wins if a kind appears twice
    for name in zf.namelist():
        if not name.lower().endswith(".csv"):
            continue
        content = zf.read(name)
        try:
            text = content.decode("utf-8-sig")
        except UnicodeDecodeError:
            continue
        reader = csv.DictReader(io.StringIO(text))
        kind = _detect_kind(reader.fieldnames) if reader.fieldnames else None
        if kind:
            detected[kind] = content

    if not detected:
        raise crud.ConflictError(
            "no devices/ports/cables/sites/roles/speeds CSV found inside the .zip -- "
            "expected a LinkLedger backup"
        )

    summary = {}
    for kind in ("devices", "ports", "cables", "sites", "roles", "speeds"):
        if kind in detected:
            result = import_csv(conn, detected[kind])
            summary[result["type"]] = result["count"]
    return summary
