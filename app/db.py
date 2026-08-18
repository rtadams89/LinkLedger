"""SQLite access layer. Deliberately not an ORM -- this is a small app,
plain sqlite3 keeps it easy to read and easy to back up (it's just a file)."""

import logging
import os
import shutil
import sqlite3
from contextlib import contextmanager

log = logging.getLogger("linkledger")

# This app was called "Patchbook" before v1.3.0, and its database defaulted
# to living at this path. LINKLEDGER_DB is the current variable name;
# PATCHBOOK_DB is still honored for a deployment that hasn't updated its
# stack's environment variables yet. If neither is set, init_db() below
# automatically migrates a database found at the old default path so
# existing data carries over with no manual steps.
_LEGACY_DB_PATH = "/data/patchbook.db"

DB_PATH = os.environ.get("LINKLEDGER_DB") or os.environ.get("PATCHBOOK_DB") or "/data/linkledger.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS devices (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL UNIQUE,
    role          TEXT NOT NULL DEFAULT '',
    model         TEXT NOT NULL DEFAULT '',
    site          TEXT NOT NULL DEFAULT '',
    notes         TEXT NOT NULL DEFAULT '',
    poe_required  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS ports (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id     INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    name          TEXT NOT NULL,
    pair_port_id  INTEGER REFERENCES ports(id) ON DELETE SET NULL,
    speed         TEXT NOT NULL DEFAULT '',
    vlans         TEXT NOT NULL DEFAULT '',
    poe_supply    INTEGER NOT NULL DEFAULT 0,
    UNIQUE(device_id, name)
);

CREATE TABLE IF NOT EXISTS cables (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    port_a_id   INTEGER NOT NULL REFERENCES ports(id) ON DELETE CASCADE,
    port_b_id   INTEGER NOT NULL REFERENCES ports(id) ON DELETE CASCADE,
    cable_type  TEXT NOT NULL DEFAULT '',
    label       TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS accounts (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    role           TEXT NOT NULL UNIQUE,
    username       TEXT NOT NULL,
    password_hash  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT
);

-- A small user-managed picklist for devices.site (see crud.py's Sites
-- section). Unlike role, there's no sensible fixed built-in list here --
-- every homelab's set of physical locations is different -- so this starts
-- empty and is built up from the Settings page. devices.site itself stays
-- a free-text column (same as role): this table is just what the "Site"
-- dropdown offers, not a foreign key constraint, so existing/imported data
-- with a site value that isn't (or is no longer) in this table is left
-- alone rather than silently blanked.
CREATE TABLE IF NOT EXISTS sites (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    name  TEXT NOT NULL UNIQUE
);

-- A "virtual switch" (role AP Group or Virtual Switch) is a device with no
-- physical ports of its own. It bridges together:
--   - its uplinks: real ports (elsewhere in the topology, e.g. an access
--     point's wired port, or a hypervisor's physical NIC) that this virtual
--     switch rides on top of -- an uplink port keeps its own normal cable
--     connection too, this table just additionally marks it as this
--     virtual switch's way out to the rest of the network.
--   - its members: ports whose ONLY connection is to this virtual switch
--     instead of a cable (a wireless client's NIC, a VM/container's vNIC)
--     -- tracked via ports.virtual_switch_id, see the migration below.
-- See pathfind.py for how this is used in path finding.
CREATE TABLE IF NOT EXISTS virtual_switch_uplinks (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    virtual_switch_id   INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    port_id             INTEGER NOT NULL UNIQUE REFERENCES ports(id) ON DELETE CASCADE
);

-- A LAG (link aggregation group) bonds two or more of a device's OWN
-- physical ports into one logical link -- e.g. a NAS with two 1G NICs
-- bonded together, or a switch-to-switch trunk over two cables. Each
-- member port keeps its own individual port record and cable (a LAG
-- doesn't change how a port is cabled); membership is just tracked via
-- ports.lag_id, see the migration below. Purely presentational/
-- informational -- path finding still traces each member port on its own.
CREATE TABLE IF NOT EXISTS lags (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id   INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    UNIQUE(device_id, name)
);
"""

# The fixed set of device roles the app supports. This used to be an
# editable database table ("Manage roles"); as of v1.5.0 it's a plain
# static list again -- a device's role is still just a free-text string in
# the database (nothing enforces it), so a device with some other role
# value (from before this list existed, or from CSV data) stays exactly as
# it is; the UI just adds it as an extra option rather than blanking it.
ROLES = [
    "Switch", "Patch Panel", "Router/Firewall", "Hypervisor", "NAS",
    "Client", "Server", "Access Point", "Appliance", "AP Group",
    "Virtual Switch", "Internet", "Other",
]

# Roles that support VLAN tagging and "Supplies PoE" on their ports --
# these are the two roles that plausibly act as network infrastructure
# (a switch bridges/tags VLANs; a router/firewall routes between them and
# may also inject PoE on some models).
VLAN_POE_CAPABLE_ROLES = ["Switch", "Router/Firewall"]

# Roles that bridge ALL of their own ports together, same as a real
# switch/router backplane -- includes the two virtual-switch roles so a
# stray physical port added to one (unusual, but not blocked) still
# behaves sensibly in the graph.
BRIDGING_ROLES = ["Switch", "Router/Firewall", "AP Group", "Virtual Switch"]

# A device with one of these roles has no physical ports of its own -- it
# bridges together its uplinks (real ports elsewhere) and its members
# (ports that join it instead of being cabled). See virtual_switch_uplinks
# above and ports.virtual_switch_id below.
VIRTUAL_SWITCH_ROLES = ["AP Group", "Virtual Switch"]


def get_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


@contextmanager
def session():
    conn = get_conn()
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    if (not os.path.exists(DB_PATH)
            and os.path.abspath(DB_PATH) != os.path.abspath(_LEGACY_DB_PATH)
            and os.path.exists(_LEGACY_DB_PATH)):
        log.warning(
            f"Found an existing database at the old default path {_LEGACY_DB_PATH} "
            f"(from before the Patchbook -> LinkLedger rename); moving it to {DB_PATH} "
            "so your existing devices, ports, and cables carry over automatically."
        )
        shutil.move(_LEGACY_DB_PATH, DB_PATH)
    with session() as conn:
        conn.executescript(SCHEMA)
        _migrate(conn)


def _migrate(conn):
    """Runs on every startup. Safe to run against a brand-new DB (everything
    is a no-op) or an existing one from an earlier version (adds any missing
    columns/tables without touching existing data)."""
    cols = {row["name"] for row in conn.execute("PRAGMA table_info(ports)").fetchall()}
    if "speed" not in cols:
        conn.execute("ALTER TABLE ports ADD COLUMN speed TEXT NOT NULL DEFAULT ''")
    if "vlans" not in cols:
        conn.execute("ALTER TABLE ports ADD COLUMN vlans TEXT NOT NULL DEFAULT ''")
    if "poe_supply" not in cols:
        conn.execute("ALTER TABLE ports ADD COLUMN poe_supply INTEGER NOT NULL DEFAULT 0")
    if "virtual_switch_id" not in cols:
        # Not declared with REFERENCES here (SQLite ALTER TABLE ADD COLUMN
        # foreign keys are finicky) -- validity is enforced in crud.py the
        # same way cable/port references already are. NULL means "not
        # virtually linked" -- the normal case for every existing port.
        conn.execute("ALTER TABLE ports ADD COLUMN virtual_switch_id INTEGER")
    if "lag_id" not in cols:
        # Same story as virtual_switch_id above -- NULL means "not part of
        # a LAG", the normal case for every existing port.
        conn.execute("ALTER TABLE ports ADD COLUMN lag_id INTEGER")

    device_cols = {row["name"] for row in conn.execute("PRAGMA table_info(devices)").fetchall()}
    if "poe_required" not in device_cols:
        conn.execute("ALTER TABLE devices ADD COLUMN poe_required INTEGER NOT NULL DEFAULT 0")

    # v1.5.0 renamed the "Workstation" role to "Client" -- carry that
    # forward for any device still using the old name. Safe to run every
    # startup: a no-op once nothing is left with the old value.
    conn.execute("UPDATE devices SET role = 'Client' WHERE role = 'Workstation'")
