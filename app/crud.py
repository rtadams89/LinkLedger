"""Business logic: validation and the connection-trace algorithm."""

import hashlib
import hmac
import json
import secrets
import sqlite3

from . import db

# Recognized port speeds, in Mbps.
SPEED_MBPS = {
    "10M": 10, "100M": 100, "1G": 1000, "2.5G": 2500,
    "5G": 5000, "10G": 10000, "25G": 25000, "40G": 40000, "100G": 100000,
}

# Reports-tab checks and their display titles/order, keyed the same as
# data_quality_report's return dict below.
REPORT_DEFS = [
    ("missing_site", "Devices missing a site"),
    ("missing_model", "Devices missing a model"),
    ("missing_role", "Devices missing a role"),
    ("unmanaged_site_values", "Site values not in your managed list"),
    ("missing_speed", "Ports missing a speed"),
    ("unused_ports", "Unused ports"),
    ("no_uplinks", "AP Groups / Virtual Switches with no uplinks"),
    ("no_ports", "Devices with no ports"),
    ("poe_unmet", "“Requires PoE” devices not actually getting it"),
    ("speed_mismatches", "End devices faster than what they're plugged into"),
]
REPORT_KEYS = [k for k, _ in REPORT_DEFS]


class ConflictError(Exception):
    """Raised for user-fixable data conflicts (duplicate name, port already
    cabled, etc). The API layer turns these into HTTP 409 responses."""


class NotFoundError(Exception):
    pass


# ---------------------------------------------------------------------------
# Devices
# ---------------------------------------------------------------------------

def list_devices(conn, q: str | None = None):
    if q:
        like = f"%{q.lower()}%"
        rows = conn.execute(
            "SELECT * FROM devices WHERE lower(name) LIKE ? OR lower(role) LIKE ? "
            "OR lower(model) LIKE ? ORDER BY name",
            (like, like, like),
        ).fetchall()
    else:
        rows = conn.execute("SELECT * FROM devices ORDER BY name").fetchall()
    return [dict(r) for r in rows]


def get_device(conn, device_id: int):
    row = conn.execute("SELECT * FROM devices WHERE id = ?", (device_id,)).fetchone()
    if not row:
        raise NotFoundError(f"device {device_id} not found")
    return dict(row)


def create_device(conn, name: str, role: str = "", model: str = "", site: str = "", notes: str = "",
                   poe_required: bool = False):
    name = name.strip()
    if not name:
        raise ConflictError("device name is required")
    try:
        cur = conn.execute(
            "INSERT INTO devices (name, role, model, site, notes, poe_required) VALUES (?, ?, ?, ?, ?, ?)",
            (name, role.strip(), model.strip(), site.strip(), notes.strip(), int(bool(poe_required))),
        )
    except sqlite3.IntegrityError:
        raise ConflictError(f"a device named '{name}' already exists")
    return get_device(conn, cur.lastrowid)


def update_device(conn, device_id: int, **fields):
    get_device(conn, device_id)  # 404 if missing
    text_fields = {"name", "role", "model", "site", "notes"}
    updates = {}
    for k, v in fields.items():
        if v is None:
            continue
        if k in text_fields:
            updates[k] = v.strip()
        elif k == "poe_required":
            updates[k] = int(bool(v))
    if not updates:
        return get_device(conn, device_id)
    set_clause = ", ".join(f"{k} = ?" for k in updates)
    try:
        conn.execute(f"UPDATE devices SET {set_clause} WHERE id = ?", (*updates.values(), device_id))
    except sqlite3.IntegrityError:
        raise ConflictError(f"a device named '{updates.get('name')}' already exists")
    return get_device(conn, device_id)


def delete_device(conn, device_id: int):
    get_device(conn, device_id)
    # Unlink any ports joined to this device as a virtual switch.
    conn.execute("UPDATE ports SET virtual_switch_id = NULL WHERE virtual_switch_id = ?", (device_id,))
    conn.execute("DELETE FROM devices WHERE id = ?", (device_id,))


# ---------------------------------------------------------------------------
# Sites -- a user-managed picklist for devices.site.
# ---------------------------------------------------------------------------

def list_sites(conn):
    rows = conn.execute("SELECT * FROM sites ORDER BY name COLLATE NOCASE").fetchall()
    return [dict(r) for r in rows]


def create_site(conn, name: str):
    name = name.strip()
    if not name:
        raise ConflictError("site name is required")
    try:
        cur = conn.execute("INSERT INTO sites (name) VALUES (?)", (name,))
    except sqlite3.IntegrityError:
        raise ConflictError(f"a site named '{name}' already exists")
    return {"id": cur.lastrowid, "name": name}


def rename_site(conn, site_id: int, new_name: str):
    row = conn.execute("SELECT * FROM sites WHERE id = ?", (site_id,)).fetchone()
    if not row:
        raise NotFoundError(f"site {site_id} not found")
    new_name = new_name.strip()
    if not new_name:
        raise ConflictError("site name is required")
    old_name = row["name"]
    if new_name != old_name:
        try:
            conn.execute("UPDATE sites SET name = ? WHERE id = ?", (new_name, site_id))
        except sqlite3.IntegrityError:
            raise ConflictError(f"a site named '{new_name}' already exists")
        # Cascade the rename to every device currently set to the old value.
        conn.execute("UPDATE devices SET site = ? WHERE site = ?", (new_name, old_name))
    return {"id": site_id, "name": new_name}


def delete_site(conn, site_id: int):
    row = conn.execute("SELECT * FROM sites WHERE id = ?", (site_id,)).fetchone()
    if not row:
        raise NotFoundError(f"site {site_id} not found")
    conn.execute("DELETE FROM sites WHERE id = ?", (site_id,))
    # devices.site values already set to this value are left untouched.


# ---------------------------------------------------------------------------
# Ports
# ---------------------------------------------------------------------------

def list_ports(conn, device_id: int):
    get_device(conn, device_id)
    rows = conn.execute("SELECT * FROM ports WHERE device_id = ? ORDER BY id", (device_id,)).fetchall()
    return [dict(r) for r in rows]


def get_port(conn, port_id: int):
    row = conn.execute("SELECT * FROM ports WHERE id = ?", (port_id,)).fetchone()
    if not row:
        raise NotFoundError(f"port {port_id} not found")
    return dict(row)


def create_port(conn, device_id: int, name: str, speed: str = "", vlans: str = "", poe_supply: bool = False):
    get_device(conn, device_id)
    name = name.strip()
    if not name:
        raise ConflictError("port name is required")
    if speed and speed not in SPEED_MBPS:
        raise ConflictError(f"unrecognized speed '{speed}'")
    try:
        cur = conn.execute(
            "INSERT INTO ports (device_id, name, speed, vlans, poe_supply) VALUES (?, ?, ?, ?, ?)",
            (device_id, name, speed.strip(), vlans.strip(), int(bool(poe_supply))),
        )
    except sqlite3.IntegrityError:
        raise ConflictError(f"this device already has a port named '{name}'")
    return get_port(conn, cur.lastrowid)


def create_ports_bulk(conn, device_id: int, names: list[str], speed: str = "", poe_supply: bool = False):
    return [create_port(conn, device_id, n, speed=speed, poe_supply=poe_supply) for n in names]


def create_patch_panel_ports(conn, device_id: int, count: int, start: int = 1):
    """Creates `count` front/rear port pairs for a patch panel, pre-paired
    so traces pass through them. `start` sets the first pair number, so
    more pairs can be added later without colliding with existing ones."""
    get_device(conn, device_id)
    created = []
    for i in range(start, start + count):
        rear = create_port(conn, device_id, f"{i} (rear)")
        front = create_port(conn, device_id, f"{i} (front)")
        conn.execute("UPDATE ports SET pair_port_id = ? WHERE id = ?", (front["id"], rear["id"]))
        conn.execute("UPDATE ports SET pair_port_id = ? WHERE id = ?", (rear["id"], front["id"]))
        created.append((get_port(conn, rear["id"]), get_port(conn, front["id"])))
    return created


def delete_port(conn, port_id: int):
    get_port(conn, port_id)
    conn.execute("DELETE FROM ports WHERE id = ?", (port_id,))


def update_port(conn, port_id: int, name: str | None = None, speed: str | None = None,
                 vlans: str | None = None, poe_supply: bool | None = None):
    """Partial update -- only fields that are not None are changed."""
    get_port(conn, port_id)
    updates = {}
    if name is not None:
        name = name.strip()
        if not name:
            raise ConflictError("port name is required")
        updates["name"] = name
    if speed is not None:
        speed = speed.strip()
        if speed and speed not in SPEED_MBPS:
            raise ConflictError(f"unrecognized speed '{speed}'")
        updates["speed"] = speed
    if vlans is not None:
        updates["vlans"] = vlans.strip()
    if poe_supply is not None:
        updates["poe_supply"] = int(bool(poe_supply))
    if not updates:
        return get_port(conn, port_id)
    set_clause = ", ".join(f"{k} = ?" for k in updates)
    try:
        conn.execute(f"UPDATE ports SET {set_clause} WHERE id = ?", (*updates.values(), port_id))
    except sqlite3.IntegrityError:
        raise ConflictError(f"this device already has a port named '{updates.get('name')}'")
    return get_port(conn, port_id)


def set_pair(conn, port_id: int, pair_port_id: int | None):
    """Pairs (or unpairs) two ports on the same device as a pass-through."""
    port = get_port(conn, port_id)
    # clear any existing pairing on this port first
    if port["pair_port_id"]:
        conn.execute("UPDATE ports SET pair_port_id = NULL WHERE id = ?", (port["pair_port_id"],))
        conn.execute("UPDATE ports SET pair_port_id = NULL WHERE id = ?", (port_id,))
    if pair_port_id is None:
        return get_port(conn, port_id)
    if port["virtual_switch_id"]:
        raise ConflictError("this port is wirelessly/virtually linked -- unlink it first")
    other = get_port(conn, pair_port_id)
    if other["device_id"] != port["device_id"]:
        raise ConflictError("paired ports must be on the same device")
    if other["virtual_switch_id"]:
        raise ConflictError("that port is wirelessly/virtually linked -- unlink it first")
    if other["pair_port_id"]:
        conn.execute("UPDATE ports SET pair_port_id = NULL WHERE id = ?", (other["pair_port_id"],))
    conn.execute("UPDATE ports SET pair_port_id = ? WHERE id = ?", (pair_port_id, port_id))
    conn.execute("UPDATE ports SET pair_port_id = ? WHERE id = ?", (port_id, pair_port_id))
    return get_port(conn, port_id)


# ---------------------------------------------------------------------------
# Interface speed picker settings -- which of SPEED_MBPS show up in the
# port speed dropdown. Stored in the `meta` key/value table as a JSON
# array under key='enabled_speeds'.
# ---------------------------------------------------------------------------

def get_enabled_speeds(conn):
    """Defaults to every recognized speed until narrowed via Settings."""
    row = conn.execute("SELECT value FROM meta WHERE key = 'enabled_speeds'").fetchone()
    if not row or not row["value"]:
        return list(SPEED_MBPS)
    try:
        saved = set(json.loads(row["value"]))
    except (ValueError, TypeError):
        return list(SPEED_MBPS)
    # Re-filter against SPEED_MBPS to drop anything no longer recognized.
    return [s for s in SPEED_MBPS if s in saved]


def set_enabled_speeds(conn, speeds: list[str]):
    unknown = [s for s in speeds if s not in SPEED_MBPS]
    if unknown:
        raise ConflictError(f"unrecognized speed(s): {', '.join(unknown)}")
    ordered = [s for s in SPEED_MBPS if s in set(speeds)]
    conn.execute(
        "INSERT INTO meta (key, value) VALUES ('enabled_speeds', ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (json.dumps(ordered),),
    )
    return ordered


# ---------------------------------------------------------------------------
# Device role picker settings -- which of the fixed roles (db.ROLES) show
# up in the Add/Edit device Role dropdown.
# ---------------------------------------------------------------------------

def get_enabled_roles(conn):
    """Defaults to every fixed role until narrowed via Settings."""
    row = conn.execute("SELECT value FROM meta WHERE key = 'enabled_roles'").fetchone()
    if not row or not row["value"]:
        return list(db.ROLES)
    try:
        saved = set(json.loads(row["value"]))
    except (ValueError, TypeError):
        return list(db.ROLES)
    return [r for r in db.ROLES if r in saved]


def set_enabled_roles(conn, roles: list[str]):
    unknown = [r for r in roles if r not in db.ROLES]
    if unknown:
        raise ConflictError(f"unrecognized role(s): {', '.join(unknown)}")
    ordered = [r for r in db.ROLES if r in set(roles)]
    conn.execute(
        "INSERT INTO meta (key, value) VALUES ('enabled_roles', ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (json.dumps(ordered),),
    )
    return ordered


# ---------------------------------------------------------------------------
# Reports-tab visibility -- which of the checks in REPORT_DEFS are shown on
# the Reports tab.
# ---------------------------------------------------------------------------

def get_enabled_reports(conn):
    """Defaults to every report until narrowed via Settings."""
    row = conn.execute("SELECT value FROM meta WHERE key = 'enabled_reports'").fetchone()
    if not row or not row["value"]:
        return list(REPORT_KEYS)
    try:
        saved = set(json.loads(row["value"]))
    except (ValueError, TypeError):
        return list(REPORT_KEYS)
    return [r for r in REPORT_KEYS if r in saved]


def set_enabled_reports(conn, reports: list[str]):
    unknown = [r for r in reports if r not in REPORT_KEYS]
    if unknown:
        raise ConflictError(f"unrecognized report(s): {', '.join(unknown)}")
    ordered = [r for r in REPORT_KEYS if r in set(reports)]
    conn.execute(
        "INSERT INTO meta (key, value) VALUES ('enabled_reports', ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (json.dumps(ordered),),
    )
    return ordered


# ---------------------------------------------------------------------------
# Virtual switches (AP Group / Virtual Switch): uplinks + member links.
# A virtual switch has no physical ports of its own. Uplinks are real
# ports elsewhere that keep their own cable too; members are ports whose
# only connection is this virtual switch, tracked via virtual_switch_id.
# ---------------------------------------------------------------------------

def _require_virtual_switch(conn, virtual_switch_id: int):
    vs = get_device(conn, virtual_switch_id)
    if vs["role"] not in db.VIRTUAL_SWITCH_ROLES:
        raise ConflictError(f"'{vs['name']}' isn't an AP Group or Virtual Switch device")
    return vs


def _unset_virtual_link(conn, port):
    """Clears virtual_switch_id on a port being unlinked. Also clears vlans
    unless the device role is VLAN/PoE-capable."""
    device = get_device(conn, port["device_id"])
    if device["role"] in db.VLAN_POE_CAPABLE_ROLES:
        conn.execute("UPDATE ports SET virtual_switch_id = NULL WHERE id = ?", (port["id"],))
    else:
        conn.execute("UPDATE ports SET virtual_switch_id = NULL, vlans = '' WHERE id = ?", (port["id"],))


def set_virtual_link(conn, port_id: int, virtual_switch_id: int | None):
    """Marks a port as joining an AP Group / Virtual Switch instead of
    being cabled. Mutually exclusive with having a cable or being paired;
    pass None to unlink."""
    port = get_port(conn, port_id)
    if virtual_switch_id is None:
        _unset_virtual_link(conn, port)
        return get_port(conn, port_id)
    _require_virtual_switch(conn, virtual_switch_id)
    if _port_cable(conn, port_id):
        raise ConflictError("this port already has a cable connected -- disconnect it first")
    if port["pair_port_id"]:
        raise ConflictError("this port is already paired with another port -- unpair it first")
    conn.execute("UPDATE ports SET virtual_switch_id = ? WHERE id = ?", (virtual_switch_id, port_id))
    return get_port(conn, port_id)


def list_uplinks(conn, virtual_switch_id: int):
    _require_virtual_switch(conn, virtual_switch_id)
    rows = conn.execute(
        "SELECT u.id, u.port_id, p.name AS port_name, d.id AS device_id, d.name AS device_name "
        "FROM virtual_switch_uplinks u "
        "JOIN ports p ON p.id = u.port_id JOIN devices d ON d.id = p.device_id "
        "WHERE u.virtual_switch_id = ? ORDER BY d.name, p.id",
        (virtual_switch_id,),
    ).fetchall()
    return [dict(r) for r in rows]


def add_uplink(conn, virtual_switch_id: int, port_id: int):
    _require_virtual_switch(conn, virtual_switch_id)
    port = get_port(conn, port_id)
    if port["device_id"] == virtual_switch_id:
        raise ConflictError("a virtual switch can't be its own uplink")
    try:
        cur = conn.execute(
            "INSERT INTO virtual_switch_uplinks (virtual_switch_id, port_id) VALUES (?, ?)",
            (virtual_switch_id, port_id),
        )
    except sqlite3.IntegrityError:
        raise ConflictError("that port is already an uplink for a virtual switch")
    return cur.lastrowid


def remove_uplink(conn, uplink_id: int):
    row = conn.execute("SELECT id FROM virtual_switch_uplinks WHERE id = ?", (uplink_id,)).fetchone()
    if not row:
        raise NotFoundError(f"uplink {uplink_id} not found")
    conn.execute("DELETE FROM virtual_switch_uplinks WHERE id = ?", (uplink_id,))


def list_members(conn, virtual_switch_id: int):
    """Ports that join this virtual switch as their only connection -- the
    read-only flip side of list_uplinks."""
    _require_virtual_switch(conn, virtual_switch_id)
    rows = conn.execute(
        "SELECT p.id AS port_id, p.name AS port_name, p.vlans AS vlans, "
        "d.id AS device_id, d.name AS device_name, d.role AS device_role "
        "FROM ports p JOIN devices d ON d.id = p.device_id "
        "WHERE p.virtual_switch_id = ? ORDER BY d.name, p.id",
        (virtual_switch_id,),
    ).fetchall()
    return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# LAGs (link aggregation groups) -- bond two or more of a device's own
# physical ports into one logical link. Each member port keeps its own
# individual cable.
# ---------------------------------------------------------------------------

def list_lags(conn, device_id: int):
    get_device(conn, device_id)
    lags = conn.execute("SELECT * FROM lags WHERE device_id = ? ORDER BY id", (device_id,)).fetchall()
    result = []
    for lag in lags:
        members = conn.execute(
            "SELECT id, name, speed FROM ports WHERE lag_id = ? ORDER BY id", (lag["id"],)
        ).fetchall()
        result.append({"id": lag["id"], "device_id": lag["device_id"], "name": lag["name"],
                        "members": [dict(m) for m in members]})
    return result


def create_lag(conn, device_id: int, name: str):
    get_device(conn, device_id)
    name = name.strip()
    if not name:
        raise ConflictError("LAG name is required")
    try:
        cur = conn.execute("INSERT INTO lags (device_id, name) VALUES (?, ?)", (device_id, name))
    except sqlite3.IntegrityError:
        raise ConflictError(f"this device already has a LAG named '{name}'")
    return cur.lastrowid


def delete_lag(conn, lag_id: int):
    row = conn.execute("SELECT id FROM lags WHERE id = ?", (lag_id,)).fetchone()
    if not row:
        raise NotFoundError(f"LAG {lag_id} not found")
    # Members just stop being marked as bonded.
    conn.execute("UPDATE ports SET lag_id = NULL WHERE lag_id = ?", (lag_id,))
    conn.execute("DELETE FROM lags WHERE id = ?", (lag_id,))


def set_port_lag(conn, port_id: int, lag_id: int | None):
    port = get_port(conn, port_id)
    if lag_id is None:
        conn.execute("UPDATE ports SET lag_id = NULL WHERE id = ?", (port_id,))
        return get_port(conn, port_id)
    lag = conn.execute("SELECT * FROM lags WHERE id = ?", (lag_id,)).fetchone()
    if not lag:
        raise NotFoundError(f"LAG {lag_id} not found")
    if lag["device_id"] != port["device_id"]:
        raise ConflictError("a LAG can only include ports on the same device")
    conn.execute("UPDATE ports SET lag_id = ? WHERE id = ?", (lag_id, port_id))
    return get_port(conn, port_id)


# ---------------------------------------------------------------------------
# Cables
# ---------------------------------------------------------------------------

def _port_cable(conn, port_id: int):
    return conn.execute(
        "SELECT * FROM cables WHERE port_a_id = ? OR port_b_id = ?", (port_id, port_id)
    ).fetchone()


def list_cables(conn):
    rows = conn.execute(
        """
        SELECT c.id, c.label,
               pa.id AS a_port_id, pa.name AS a_port_name, pa.speed AS a_speed,
               da.id AS a_device_id, da.name AS a_device_name,
               pb.id AS b_port_id, pb.name AS b_port_name, pb.speed AS b_speed,
               db.id AS b_device_id, db.name AS b_device_name
        FROM cables c
        JOIN ports pa ON pa.id = c.port_a_id JOIN devices da ON da.id = pa.device_id
        JOIN ports pb ON pb.id = c.port_b_id JOIN devices db ON db.id = pb.device_id
        ORDER BY da.name, pa.id
        """
    ).fetchall()
    cables = [dict(r) for r in rows]
    for c in cables:
        speeds = [s for s in (c["a_speed"], c["b_speed"]) if s]
        c["effective_speed"] = min(speeds, key=lambda s: SPEED_MBPS.get(s, 0)) if speeds else None
    return cables


def create_cable(conn, port_a_id: int, port_b_id: int, label: str = "", overwrite: bool = False):
    """Cables two ports together. Both ports must be free (no existing
    cable, no wireless/virtual link) unless overwrite=True, which instead
    disconnects whatever's currently on either port first. Patch-panel
    pairing and LAG membership are untouched either way."""
    if port_a_id == port_b_id:
        raise ConflictError("a port can't be cabled to itself")
    pa = get_port(conn, port_a_id)
    pb = get_port(conn, port_b_id)
    if overwrite:
        for p in (pa, pb):
            if p["virtual_switch_id"]:
                _unset_virtual_link(conn, p)
            existing = _port_cable(conn, p["id"])
            if existing:
                conn.execute("DELETE FROM cables WHERE id = ?", (existing["id"],))
    else:
        if pa["virtual_switch_id"]:
            raise ConflictError("that source port is wirelessly/virtually linked -- unlink it first")
        if pb["virtual_switch_id"]:
            raise ConflictError("that destination port is wirelessly/virtually linked -- unlink it first")
        if _port_cable(conn, port_a_id):
            raise ConflictError("that source port already has a cable connected -- disconnect it first")
        if _port_cable(conn, port_b_id):
            raise ConflictError("that destination port already has a cable connected -- disconnect it first")
    cur = conn.execute(
        "INSERT INTO cables (port_a_id, port_b_id, label) VALUES (?, ?, ?)",
        (port_a_id, port_b_id, label.strip()),
    )
    return cur.lastrowid


def delete_cable_by_port(conn, port_id: int):
    cable = _port_cable(conn, port_id)
    if not cable:
        raise NotFoundError("that port has no cable to remove")
    conn.execute("DELETE FROM cables WHERE id = ?", (cable["id"],))


def delete_cable(conn, cable_id: int):
    row = conn.execute("SELECT id FROM cables WHERE id = ?", (cable_id,)).fetchone()
    if not row:
        raise NotFoundError(f"cable {cable_id} not found")
    conn.execute("DELETE FROM cables WHERE id = ?", (cable_id,))


# ---------------------------------------------------------------------------
# Trace: walk cables + same-device pass-through pairs (patch panel front/rear)
# ---------------------------------------------------------------------------

def _port_hop(conn, port_id: int, cable=None):
    """Builds one trace hop dict for arriving at a real port."""
    row = conn.execute(
        "SELECT ports.*, devices.name AS device_name, devices.role AS device_role FROM ports "
        "JOIN devices ON devices.id = ports.device_id WHERE ports.id = ?",
        (port_id,),
    ).fetchone()
    p = dict(row)
    return {
        "port_id": p["id"],
        "port_name": p["name"],
        "device_id": p["device_id"],
        "device_name": p["device_name"],
        "device_role": p["device_role"],
        "speed": p["speed"],
        "vlans": p["vlans"],
        "poe_supply": p["poe_supply"],
        "cable_id": cable["id"] if cable else None,
        "cable_label": cable["label"] if cable else "",
    }


def trace(conn, start_port_id: int, max_hops: int = 16):
    """Returns a list of hops from start_port_id to the far end of the
    connection; an empty list means the starting port isn't connected to
    anything. A port linked only to a virtual switch produces a "virtual"
    hop; if that switch has exactly one uplink the trace continues through
    it, otherwise it stops there."""
    get_port(conn, start_port_id)
    hops = []
    seen = {start_port_id}
    cur = start_port_id
    for _ in range(max_hops):
        cur_port = get_port(conn, cur)
        if cur_port["virtual_switch_id"]:
            vs = get_device(conn, cur_port["virtual_switch_id"])
            uplinks = list_uplinks(conn, vs["id"])
            hops.append({
                "port_id": None,
                "port_name": "wireless" if vs["role"] == "AP Group" else "virtual link",
                "device_id": vs["id"],
                "device_name": vs["name"],
                "device_role": vs["role"],
                "speed": "",
                "vlans": "",
                "poe_supply": 0,
                "cable_id": None,
                "cable_label": "",
                "virtual": True,
                "uplink_count": len(uplinks),
            })
            if len(uplinks) != 1 or uplinks[0]["port_id"] in seen:
                break
            nxt = uplinks[0]["port_id"]
            seen.add(nxt)
            # The uplink port is a real stop in the chain; show it before
            # continuing to trace whatever it's cabled to.
            hops.append(_port_hop(conn, nxt))
            cur = nxt
            continue

        cable = _port_cable(conn, cur)
        if not cable:
            break
        other_id = cable["port_b_id"] if cable["port_a_id"] == cur else cable["port_a_id"]
        if other_id in seen:
            break  # cycle guard
        seen.add(other_id)
        other = _port_hop(conn, other_id, cable)
        hops.append(other)
        other_row = get_port(conn, other_id)
        if other_row["pair_port_id"] and other_row["pair_port_id"] not in seen:
            seen.add(other_row["pair_port_id"])
            cur = other_row["pair_port_id"]
        else:
            break
    return hops


def effective_speed(start_port, hops):
    """The slowest speed set on any real endpoint along the chain. None if
    nothing is set anywhere."""
    speeds = [start_port.get("speed")] + [h.get("speed") for h in hops]
    speeds = [s for s in speeds if s]
    if not speeds:
        return None
    return min(speeds, key=lambda s: SPEED_MBPS.get(s, 0))


def effective_vlans(hops):
    """VLANs tagged on the switch/router port at the far end of the chain."""
    for h in hops:
        if h.get("device_role") in db.VLAN_POE_CAPABLE_ROLES and h.get("vlans"):
            return h["vlans"]
    return ""


def effective_poe_supplied(hops):
    """True if the switch/router port at the far end of the chain supplies
    PoE. Stops at the first virtual hop, if any."""
    for h in hops:
        if h.get("virtual"):
            return False
        if h.get("device_role") in db.VLAN_POE_CAPABLE_ROLES and h.get("poe_supply"):
            return True
    return False




# ---------------------------------------------------------------------------
# Admin
# ---------------------------------------------------------------------------

def clear_all_connections(conn):
    """Disconnects every cable and wireless/virtual link, leaving devices,
    ports, patch-panel pairing, and LAG groupings alone."""
    conn.execute("DELETE FROM cables")
    conn.execute("UPDATE ports SET virtual_switch_id = NULL WHERE virtual_switch_id IS NOT NULL")
    conn.execute("DELETE FROM virtual_switch_uplinks")


def reset_all_data(conn):
    """Wipes every device, port, and cable, clears the Sites list, and
    resets the role/speed/report picker settings back to their defaults."""
    conn.execute("DELETE FROM cables")
    conn.execute("DELETE FROM ports")
    conn.execute("DELETE FROM devices")
    conn.execute("DELETE FROM sites")
    conn.execute("DELETE FROM meta WHERE key IN ('enabled_roles', 'enabled_speeds', 'enabled_reports')")


# ---------------------------------------------------------------------------
# Accounts / auth -- one admin account, one viewer account. Passwords are
# hashed with PBKDF2-HMAC-SHA256.
# ---------------------------------------------------------------------------

_PBKDF2_ITERATIONS = 260_000


def _hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, _PBKDF2_ITERATIONS)
    return f"pbkdf2_sha256${_PBKDF2_ITERATIONS}${salt.hex()}${dk.hex()}"


def _verify_password(password: str, stored_hash: str) -> bool:
    try:
        algo, iterations, salt_hex, hash_hex = stored_hash.split("$")
        iterations = int(iterations)
        salt = bytes.fromhex(salt_hex)
        expected = bytes.fromhex(hash_hex)
    except (ValueError, AttributeError):
        return False
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
    return hmac.compare_digest(dk, expected)


def seed_accounts(conn, admin_user: str, admin_pass: str, viewer_user: str, viewer_pass: str):
    """Creates the admin/viewer account rows if they don't exist yet."""
    existing = {row["role"] for row in conn.execute("SELECT role FROM accounts").fetchall()}
    if "admin" not in existing:
        conn.execute(
            "INSERT INTO accounts (role, username, password_hash) VALUES (?, ?, ?)",
            ("admin", admin_user, _hash_password(admin_pass)),
        )
    if "viewer" not in existing:
        conn.execute(
            "INSERT INTO accounts (role, username, password_hash) VALUES (?, ?, ?)",
            ("viewer", viewer_user, _hash_password(viewer_pass)),
        )


def is_default_password(conn, role: str, default_password: str) -> bool:
    """True if the account for this role still has the given default
    password."""
    row = conn.execute("SELECT password_hash FROM accounts WHERE role = ?", (role,)).fetchone()
    return bool(row) and _verify_password(default_password, row["password_hash"])


def get_account(conn, role: str):
    row = conn.execute("SELECT role, username FROM accounts WHERE role = ?", (role,)).fetchone()
    return dict(row) if row else None


def verify_login(conn, username: str, password: str):
    """Returns {"role": ..., "username": ...} on success, or None."""
    row = conn.execute("SELECT * FROM accounts WHERE username = ?", (username,)).fetchone()
    if not row or not _verify_password(password, row["password_hash"]):
        return None
    return {"role": row["role"], "username": row["username"]}


def change_password(conn, role: str, current_password: str, new_password: str):
    """Changes the password for the account with this role after verifying
    current_password. Returns the updated account dict, or None if
    current_password was wrong."""
    row = conn.execute("SELECT * FROM accounts WHERE role = ?", (role,)).fetchone()
    if not row or not _verify_password(current_password, row["password_hash"]):
        return None
    conn.execute(
        "UPDATE accounts SET password_hash = ? WHERE role = ?",
        (_hash_password(new_password), role),
    )
    return {"role": row["role"], "username": row["username"]}


def set_password(conn, role: str, new_password: str):
    """Sets the password for the account with this role without checking
    current_password. Raises NotFoundError if the account doesn't exist."""
    row = conn.execute("SELECT * FROM accounts WHERE role = ?", (role,)).fetchone()
    if not row:
        raise NotFoundError(f"no {role} account")
    conn.execute(
        "UPDATE accounts SET password_hash = ? WHERE role = ?",
        (_hash_password(new_password), role),
    )
    return {"role": row["role"], "username": row["username"]}


# ---------------------------------------------------------------------------
# Reports -- read-only data-quality checks for the Reports tab.
# ---------------------------------------------------------------------------

def data_quality_report(conn):
    devices = list_devices(conn)
    site_names = {s["name"] for s in list_sites(conn)}

    # Site and Model don't apply to the Internet device.
    missing_site = [d for d in devices if not d["site"] and d["role"] != "Internet"]
    missing_model = [d for d in devices if not d["model"] and d["role"] != "Internet"]
    missing_role = [d for d in devices if not d["role"]]
    no_ports = []

    # Site values in use that aren't in the managed Sites list, grouped by
    # value with a count.
    unmanaged_by_value = {}
    for d in devices:
        site = d["site"]
        if site and site not in site_names:
            unmanaged_by_value.setdefault(site, []).append(d)
    unmanaged_site_values = [
        {"site": site, "devices": devs}
        for site, devs in sorted(unmanaged_by_value.items(), key=lambda kv: kv[0].lower())
    ]

    all_ports = []
    for d in devices:
        ports = list_ports(conn, d["id"])
        # AP Group / Virtual Switch devices are ports-less by design.
        if not ports and d["role"] not in db.VIRTUAL_SWITCH_ROLES:
            no_ports.append(d)
        for p in ports:
            p["device_id"] = d["id"]
            p["device_name"] = d["name"]
            p["device_role"] = d["role"]
            all_ports.append(p)

    cabled_port_ids = set()
    for c in list_cables(conn):
        cabled_port_ids.add(c["a_port_id"])
        cabled_port_ids.add(c["b_port_id"])

    # Ports that should have a speed and don't, excluding patch panel,
    # virtual-switch member, and Internet device ports.
    missing_speed = [
        p for p in all_ports
        if not p["speed"] and not p["virtual_switch_id"]
        and p["device_role"] not in ("Patch Panel", "Internet")
    ]

    # Unused: no cable, no pairing, no virtual-switch link.
    unused_ports = [
        p for p in all_ports
        if p["id"] not in cabled_port_ids and not p["pair_port_id"] and not p["virtual_switch_id"]
    ]

    # AP Group / Virtual Switch devices with no uplinks defined.
    no_uplinks = [
        d for d in devices
        if d["role"] in db.VIRTUAL_SWITCH_ROLES and not list_uplinks(conn, d["id"])
    ]

    # Devices requiring PoE where nothing in any port's trace supplies it.
    poe_unmet = []
    for d in devices:
        if not d["poe_required"]:
            continue
        ports = [p for p in all_ports if p["device_id"] == d["id"]]
        if ports and any(effective_poe_supplied(trace(conn, p["id"])) for p in ports):
            continue
        poe_unmet.append(d)

    # End devices rated faster than the switch/router port they connect
    # to. Only considers real, rated end-device ports; the trace is walked
    # past any patch panels in between to find the next real device.
    speed_mismatches = []
    for p in all_ports:
        if not p["speed"] or p["virtual_switch_id"]:
            continue
        if p["device_role"] in ("Patch Panel", "Internet") or p["device_role"] in db.VLAN_POE_CAPABLE_ROLES:
            continue
        target = None
        for hop in trace(conn, p["id"]):
            if hop["device_role"] == "Patch Panel":
                continue
            target = hop
            break
        if not target or target["device_role"] not in db.VLAN_POE_CAPABLE_ROLES or not target["speed"]:
            continue
        if SPEED_MBPS.get(p["speed"], 0) > SPEED_MBPS.get(target["speed"], 0):
            speed_mismatches.append({
                "device_id": p["device_id"], "device_name": p["device_name"],
                "device_role": p["device_role"],
                "port_id": p["id"], "port_name": p["name"], "port_speed": p["speed"],
                "target_device_id": target["device_id"], "target_device_name": target["device_name"],
                "target_device_role": target["device_role"],
                "target_port_id": target["port_id"], "target_port_name": target["port_name"],
                "target_port_speed": target["speed"],
            })

    return {
        "missing_site": missing_site,
        "missing_model": missing_model,
        "missing_role": missing_role,
        "unmanaged_site_values": unmanaged_site_values,
        "missing_speed": missing_speed,
        "unused_ports": unused_ports,
        "no_uplinks": no_uplinks,
        "no_ports": no_ports,
        "poe_unmet": poe_unmet,
        "speed_mismatches": speed_mismatches,
    }
