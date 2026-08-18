"""Business logic: validation + the connection-trace algorithm, kept separate
from the HTTP layer so it can be unit-tested directly."""

import hashlib
import hmac
import json
import secrets
import sqlite3

from . import db

# Recognized port speeds, in Mbps, used to work out the effective (slowest
# common denominator) speed of a connection from the speeds set on each end.
SPEED_MBPS = {
    "10M": 10, "100M": 100, "1G": 1000, "2.5G": 2500,
    "5G": 5000, "10G": 10000, "25G": 25000, "40G": 40000, "100G": 100000,
}


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
    # If this was an AP Group / Virtual Switch, any ports that were joined
    # to it (wireless clients, VM/container vNICs) lose that link rather
    # than being left pointing at a deleted device. Harmless no-op update
    # for any other device role.
    conn.execute("UPDATE ports SET virtual_switch_id = NULL WHERE virtual_switch_id = ?", (device_id,))
    conn.execute("DELETE FROM devices WHERE id = ?", (device_id,))


# ---------------------------------------------------------------------------
# Sites -- a small user-managed picklist for devices.site. See db.py's
# `sites` table comment for why this isn't a fixed built-in list the way
# role is. A device's site is still just a free-text column underneath
# (create_device/update_device don't check it against this table), so
# nothing here can silently blank existing data -- see delete_site below.
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
        # Cascade the rename to every device currently set to the old value
        # -- a rename means "same place, new label," unlike delete below.
        conn.execute("UPDATE devices SET site = ? WHERE site = ?", (new_name, old_name))
    return {"id": site_id, "name": new_name}


def delete_site(conn, site_id: int):
    row = conn.execute("SELECT * FROM sites WHERE id = ?", (site_id,)).fetchone()
    if not row:
        raise NotFoundError(f"site {site_id} not found")
    conn.execute("DELETE FROM sites WHERE id = ?", (site_id,))
    # Deliberately NOT touching devices.site for anything already set to
    # this value -- same rule as removing a role from the fixed list not
    # blanking devices that already use it. It just stops being offered for
    # new picks; the Reports page (data_quality_report) flags any device
    # whose site value isn't in this list, so a value orphaned by a delete
    # like this one is easy to find and clean up later if you want to.


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


def create_patch_panel_ports(conn, device_id: int, count: int):
    """Convenience: create N front/rear port pairs for a patch panel,
    pre-paired so traces automatically pass through them."""
    get_device(conn, device_id)
    created = []
    for i in range(1, count + 1):
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
    """Partial update -- only fields that are not None are changed. Covers
    what used to be rename_port() plus the new speed/VLAN/PoE fields."""
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
    """Manually pair (or unpair) two ports on the same device as a
    pass-through, e.g. for patch panels not created via the bulk helper."""
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
# Interface speed picker settings -- which of the recognized speeds
# (SPEED_MBPS above) show up in the port speed dropdown. Purely a UI
# convenience for hiding speeds a given network will never use (e.g.
# 40G/100G on a home network) so they don't clutter the picker every time --
# it does NOT change what's a legal value. Any of SPEED_MBPS's keys is
# always accepted by create_port/update_port/CSV import regardless of this
# setting, so hiding a speed here can never blank or break a port that
# already has it set -- that value just stops being offered for NEW picks.
# Stored in the `meta` key/value table (key='enabled_speeds', a JSON array)
# rather than its own table, since it's a single setting, not a list of
# distinct records the user creates/renames/deletes the way sites are.
# ---------------------------------------------------------------------------

def get_enabled_speeds(conn):
    """Defaults to every recognized speed (i.e. today's fixed dropdown,
    unchanged) until someone visits Settings and narrows it down."""
    row = conn.execute("SELECT value FROM meta WHERE key = 'enabled_speeds'").fetchone()
    if not row or not row["value"]:
        return list(SPEED_MBPS)
    try:
        saved = set(json.loads(row["value"]))
    except (ValueError, TypeError):
        return list(SPEED_MBPS)
    # Re-filter against SPEED_MBPS (in its canonical slowest->fastest order)
    # rather than trusting the stored list verbatim, in case a future
    # version ever changes what's recognized.
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
# up in the Add/Edit device Role dropdown. Same story as the speed picker
# settings just above: role itself STAYS a fixed, non-user-editable list
# (see db.ROLES's comment for why -- v1.5.0 walked back a fully custom
# role list, and several roles drive real behavior like bridging/VLAN/PoE
# options and path finding, unlike a site name or a speed rating). This
# only controls which of that fixed list are OFFERED, for someone who
# knows they'll never add a Patch Panel or a Hypervisor and would rather
# not scroll past them every time. Hiding a role here can never blank or
# break a device that already has it set -- create_device/update_device
# don't check against this, so it's exactly as non-destructive as hiding a
# speed.
# ---------------------------------------------------------------------------

def get_enabled_roles(conn):
    """Defaults to every fixed role (i.e. today's full dropdown, unchanged)
    until someone visits Settings and hides some."""
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
# Virtual switches (AP Group / Virtual Switch): uplinks + member links
#
# A virtual switch has no physical ports of its own. It bridges together:
#   - uplinks: real ports elsewhere in the topology that keep their own
#     normal cable too (an access point's wired port, a hypervisor's
#     physical NIC) -- this just additionally marks that port as this
#     virtual switch's way out to the rest of the network.
#   - members: ports whose ONLY connection is to this virtual switch
#     instead of a cable (a wireless client's NIC, a VM/container's vNIC)
#     -- tracked directly on the port via virtual_switch_id.
# ---------------------------------------------------------------------------

def _require_virtual_switch(conn, virtual_switch_id: int):
    vs = get_device(conn, virtual_switch_id)
    if vs["role"] not in db.VIRTUAL_SWITCH_ROLES:
        raise ConflictError(f"'{vs['name']}' isn't an AP Group or Virtual Switch device")
    return vs


def set_virtual_link(conn, port_id: int, virtual_switch_id: int | None):
    """Marks a port as joining an AP Group / Virtual Switch instead of
    being cabled -- e.g. a wireless client's NIC, or a VM/container's vNIC.
    Mutually exclusive with having a cable or being paired; pass None to
    unlink."""
    port = get_port(conn, port_id)
    if virtual_switch_id is None:
        conn.execute("UPDATE ports SET virtual_switch_id = NULL WHERE id = ?", (port_id,))
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
    """Ports elsewhere that join this virtual switch as their only
    connection (a wireless client's NIC, a VM/container's vNIC) -- the
    read-only flip side of list_uplinks. New members are added from the
    member port's own "connect" flow (set_virtual_link), not from here."""
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
# LAGs (link aggregation groups) -- bond two or more of a device's OWN
# physical ports into one logical link (e.g. a NAS's two bonded NICs, or a
# switch-to-switch trunk over two cables). Each member port keeps its own
# individual cable; this is purely a grouping/label on top of that, so
# path finding still traces each member port independently.
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
    # Members just stop being marked as bonded -- their ports and cables
    # are untouched.
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
    """Cables two ports together. By default both ports must be free (no
    existing cable, no wireless/virtual link) -- same as always. Pass
    overwrite=True (the frontend does this only after the user confirms a
    warning) to instead silently disconnect whatever's currently on either
    port first -- a cable, or a wireless/virtual link -- so moving a cable
    to a port that's already in use is one call instead of
    disconnect-then-reconnect. Patch-panel pairing and LAG membership are
    untouched either way -- overwriting a cable doesn't change what a port
    IS, just what it's currently plugged into."""
    if port_a_id == port_b_id:
        raise ConflictError("a port can't be cabled to itself")
    pa = get_port(conn, port_a_id)
    pb = get_port(conn, port_b_id)
    if overwrite:
        for p in (pa, pb):
            if p["virtual_switch_id"]:
                conn.execute("UPDATE ports SET virtual_switch_id = NULL WHERE id = ?", (p["id"],))
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
    """Builds one trace hop dict for arriving at a real port (via cable, or
    via a pass-through pair -- callers pass the cable row when there is
    one)."""
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
    """Returns a list of hops, each a dict with device/port info and whether
    it was reached via a same-device pass-through. The last hop is the far
    end; an empty list means the starting port isn't connected to anything.

    A port whose ONLY connection is to an AP Group / Virtual Switch (see
    set_virtual_link above) produces a "virtual" hop for that device instead
    of a cable hop. If that virtual switch has exactly one uplink, the trace
    continues through it as normal (e.g. wireless client -> AP Group ->
    the one AP's wired port -> ... -> a switch). With zero or more than one
    uplink there's no single deterministic path, so the trace stops at the
    virtual hop -- callers can use hop["uplink_count"] to say e.g. "reachable
    via 3 APs" rather than showing a path that isn't really "the" path."""
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
            # The uplink port itself is a real stop in the chain (e.g. the
            # AP's own wired port) -- show it before continuing to trace
            # whatever it's cabled to.
            hops.append(_port_hop(conn, nxt))
            cur = nxt
            continue

        cable = _port_cable(conn, cur)
        if not cable:
            break
        other_id = cable["port_b_id"] if cable["port_a_id"] == cur else cable["port_a_id"]
        if other_id in seen:
            break  # cycle guard -- shouldn't happen, but don't hang if it does
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
    """The link's effective speed is the slowest speed set on any real
    endpoint along the chain (patch panel ports are pass-through and only
    count if someone's explicitly rated one). None if nothing is set
    anywhere, so the UI can just show nothing instead of a false '10M'."""
    speeds = [start_port.get("speed")] + [h.get("speed") for h in hops]
    speeds = [s for s in speeds if s]
    if not speeds:
        return None
    return min(speeds, key=lambda s: SPEED_MBPS.get(s, 0))


def effective_vlans(hops):
    """VLANs tagged on the switch/router port at the far end of the chain,
    carried forward so the device plugged into that port shows what
    VLAN(s) it's actually on without having to go look at the switch."""
    for h in hops:
        if h.get("device_role") in db.VLAN_POE_CAPABLE_ROLES and h.get("vlans"):
            return h["vlans"]
    return ""


def effective_poe_supplied(hops):
    """True if the switch/router port at the far end of the chain is
    tagged as supplying PoE -- used to flag a device that needs power but
    isn't actually plugged into a PoE-capable port. Stops at the first
    virtual (wireless/virtual-switch) hop, if any -- PoE can't cross a
    wireless link or a hypervisor's internal bridge, so a switch port
    further down the chain (e.g. the one powering an access point) doesn't
    count as powering whatever's virtually linked through it."""
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
    """Disconnects everything -- every cable, and every wireless/virtual
    link (both AP Group / Virtual Switch uplinks and the member ports
    joined to them) -- while leaving devices and ports themselves alone.
    Patch-panel front/rear pairing and LAG groupings are also left alone:
    those describe what a port structurally IS, not what it's currently
    plugged into, so they still make sense once you start re-cabling.
    Handy when physically re-cabling a large swath of your network and
    you'd rather start the connections from a clean slate than delete them
    one at a time."""
    conn.execute("DELETE FROM cables")
    conn.execute("UPDATE ports SET virtual_switch_id = NULL WHERE virtual_switch_id IS NOT NULL")
    conn.execute("DELETE FROM virtual_switch_uplinks")


def reset_all_data(conn):
    """Wipes every device, port, and cable -- a true blank slate -- and also
    clears the Sites list and resets the Device roles / Interface speeds
    picker settings back to their full default (everything enabled). This
    is the "start documenting a completely different environment from
    scratch" button, so it clears every bit of *your* customization, not
    just the topology data -- the fixed Roles list itself (db.ROLES) is the
    only thing that can't change, since it's not user data to begin with."""
    conn.execute("DELETE FROM cables")
    conn.execute("DELETE FROM ports")
    conn.execute("DELETE FROM devices")
    conn.execute("DELETE FROM sites")
    conn.execute("DELETE FROM meta WHERE key IN ('enabled_roles', 'enabled_speeds')")


# ---------------------------------------------------------------------------
# Accounts / auth
#
# Two accounts, one per role ("admin", "viewer"). Passwords are hashed with
# PBKDF2-HMAC-SHA256 (stdlib only, no extra dependency) -- never stored or
# compared in plaintext. seed_accounts() creates the two rows the FIRST time
# the app boots (see main.py for the fixed usernames and the admin
# default/viewer random passwords it's called with); after that the
# database is the source of truth and the Settings page is how you update
# a password -- seed_accounts() is a no-op on every boot after the first.
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
    """Creates the admin/viewer account rows if they don't exist yet. A
    no-op on every boot after the first, regardless of what the environment
    variables currently say."""
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
    """True if the account currently in the database for this role still has
    the given built-in default password -- used to nag on every startup
    until it's actually changed, rather than just checking the environment
    variable (which stops mattering after the account is first created)."""
    row = conn.execute("SELECT password_hash FROM accounts WHERE role = ?", (role,)).fetchone()
    return bool(row) and _verify_password(default_password, row["password_hash"])


def get_account(conn, role: str):
    row = conn.execute("SELECT role, username FROM accounts WHERE role = ?", (role,)).fetchone()
    return dict(row) if row else None


def verify_login(conn, username: str, password: str):
    """Returns {"role": ..., "username": ...} on success, or None if the
    username/password don't match any account."""
    row = conn.execute("SELECT * FROM accounts WHERE username = ?", (username,)).fetchone()
    if not row or not _verify_password(password, row["password_hash"]):
        return None
    return {"role": row["role"], "username": row["username"]}


def change_password(conn, role: str, current_password: str, new_password: str):
    """Changes the password for the account with this role, after checking
    current_password against what's stored. Returns the updated
    {"role": ..., "username": ...} on success, or None if current_password
    was wrong (or the account doesn't exist, which shouldn't happen)."""
    row = conn.execute("SELECT * FROM accounts WHERE role = ?", (role,)).fetchone()
    if not row or not _verify_password(current_password, row["password_hash"]):
        return None
    conn.execute(
        "UPDATE accounts SET password_hash = ? WHERE role = ?",
        (_hash_password(new_password), role),
    )
    return {"role": row["role"], "username": row["username"]}


def set_password(conn, role: str, new_password: str):
    """Admin-override password set: no current_password check, since this
    is the admin setting the *other* account's (viewer's) password on its
    behalf, not changing their own. Raises NotFoundError if the account
    doesn't exist (shouldn't happen -- both accounts are seeded on first
    boot). Returns the updated {"role": ..., "username": ...}."""
    row = conn.execute("SELECT * FROM accounts WHERE role = ?", (role,)).fetchone()
    if not row:
        raise NotFoundError(f"no {role} account")
    conn.execute(
        "UPDATE accounts SET password_hash = ? WHERE role = ?",
        (_hash_password(new_password), role),
    )
    return {"role": row["role"], "username": row["username"]}


# ---------------------------------------------------------------------------
# Reports -- read-only data-quality checks for the Reports tab. Every check
# here just points out where the topology documentation looks incomplete;
# none of them change anything. Keep this list additive (new checks are
# easy and safe to add) but don't get carried away flagging things that are
# routinely and legitimately left blank -- e.g. patch panel ports never
# getting a speed rating in practice, which is why that check specifically
# excludes them below.
# ---------------------------------------------------------------------------

def data_quality_report(conn):
    devices = list_devices(conn)
    site_names = {s["name"] for s in list_sites(conn)}

    # Site and Model don't apply to the Internet device -- it's a
    # documentation-only stand-in for "the public internet" (see its seeded
    # notes), not a real piece of hardware sitting at a location, so it's
    # excluded from both of these rather than permanently nagging about
    # fields that were never meant to be filled in.
    missing_site = [d for d in devices if not d["site"] and d["role"] != "Internet"]
    missing_model = [d for d in devices if not d["model"] and d["role"] != "Internet"]
    missing_role = [d for d in devices if not d["role"]]
    no_ports = []

    # Site values in use that aren't (or no longer are) in the managed
    # Sites list -- grouped by value with a count, rather than one row per
    # device, since the interesting fact is "this value exists and isn't
    # recognized," not each individual device (could be many, e.g. right
    # after upgrading to this version with pre-existing free-text sites).
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
        # AP Group / Virtual Switch devices are ports-less by design -- they
        # bridge uplinks and members instead (see VIRTUAL_SWITCH_ROLES), so
        # having zero rows in the ports table is the expected, correct
        # state for them, not something to flag here.
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

    # Ports that plausibly SHOULD have a speed and don't -- excludes patch
    # panel pass-through ports (never meaningfully "rated" in practice, and
    # would otherwise dominate this list for anyone using patch panels),
    # virtual-switch member ports (a wireless client's NIC etc. has no real
    # speed of its own to set), and the Internet device's documentation-only
    # WAN-uplink ports (not a real rated interface either).
    missing_speed = [
        p for p in all_ports
        if not p["speed"] and not p["virtual_switch_id"]
        and p["device_role"] not in ("Patch Panel", "Internet")
    ]

    # Genuinely just sitting there unused: no cable, not paired with
    # another port on the same device, not a virtual-switch member.
    unused_ports = [
        p for p in all_ports
        if p["id"] not in cabled_port_ids and not p["pair_port_id"] and not p["virtual_switch_id"]
    ]

    # AP Group / Virtual Switch devices with no uplinks defined -- these
    # can never actually reach the rest of the network (see pathfind.py),
    # so this is worth surfacing even though it's not a "missing field" in
    # the usual sense.
    no_uplinks = [
        d for d in devices
        if d["role"] in db.VIRTUAL_SWITCH_ROLES and not list_uplinks(conn, d["id"])
    ]

    # Devices flagged "Requires PoE" where nothing in any port's trace
    # actually supplies it -- the per-port version of this already shows as
    # a red tag on the device page (see effective_poe_supplied); this is
    # just the same check rolled up so it doesn't take clicking into every
    # device to notice.
    poe_unmet = []
    for d in devices:
        if not d["poe_required"]:
            continue
        ports = [p for p in all_ports if p["device_id"] == d["id"]]
        if ports and any(effective_poe_supplied(trace(conn, p["id"])) for p in ports):
            continue
        poe_unmet.append(d)

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
    }
