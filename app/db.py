"""SQLite access layer."""

import logging
import os
import shutil
import sqlite3
from contextlib import contextmanager

log = logging.getLogger("linkledger")

# Old default database path; init_db() migrates a database found here to
# DB_PATH automatically.
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

-- A user-managed picklist for devices.site, built up from the Settings
-- page. Just what the "Site" dropdown offers, not a foreign key
-- constraint -- devices.site stays a free-text column.
CREATE TABLE IF NOT EXISTS sites (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    name  TEXT NOT NULL UNIQUE
);

-- A "virtual switch" (role AP Group or Virtual Switch) is a device with no
-- physical ports of its own. It bridges together its uplinks (real ports
-- elsewhere that keep their own cable too) and its members (ports whose
-- only connection is this virtual switch, tracked via
-- ports.virtual_switch_id, see the migration below).
CREATE TABLE IF NOT EXISTS virtual_switch_uplinks (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    virtual_switch_id   INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    port_id             INTEGER NOT NULL UNIQUE REFERENCES ports(id) ON DELETE CASCADE
);

-- A LAG (link aggregation group) bonds two or more of a device's own
-- physical ports into one logical link. Each member port keeps its own
-- individual port record and cable; membership is tracked via
-- ports.lag_id, see the migration below.
CREATE TABLE IF NOT EXISTS lags (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id   INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    UNIQUE(device_id, name)
);
"""

# The fixed set of device roles the app supports. A device's role is just
# a free-text string in the database; nothing enforces it.
ROLES = [
    "Switch", "Patch Panel", "Router/Firewall", "Hypervisor", "NAS",
    "Client", "Server", "Access Point", "Appliance", "AP Group",
    "Virtual Switch", "Internet", "Other",
]

# Roles that support VLAN tagging and "Supplies PoE" on their ports.
VLAN_POE_CAPABLE_ROLES = ["Switch", "Router/Firewall"]

# Roles that bridge all of their own ports together.
BRIDGING_ROLES = ["Switch", "Router/Firewall", "AP Group", "Virtual Switch"]

# Roles with no physical ports of their own; they bridge their uplinks and
# members instead. See virtual_switch_uplinks above and
# ports.virtual_switch_id below.
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
        log.warning(f"Found an existing database at {_LEGACY_DB_PATH}; moving it to {DB_PATH}.")
        shutil.move(_LEGACY_DB_PATH, DB_PATH)
    with session() as conn:
        conn.executescript(SCHEMA)
        _migrate(conn)


def _migrate(conn):
    """Adds any missing columns/tables without touching existing data."""
    cols = {row["name"] for row in conn.execute("PRAGMA table_info(ports)").fetchall()}
    if "speed" not in cols:
        conn.execute("ALTER TABLE ports ADD COLUMN speed TEXT NOT NULL DEFAULT ''")
    if "vlans" not in cols:
        conn.execute("ALTER TABLE ports ADD COLUMN vlans TEXT NOT NULL DEFAULT ''")
    if "poe_supply" not in cols:
        conn.execute("ALTER TABLE ports ADD COLUMN poe_supply INTEGER NOT NULL DEFAULT 0")
    if "virtual_switch_id" not in cols:
        # NULL means not virtually linked.
        conn.execute("ALTER TABLE ports ADD COLUMN virtual_switch_id INTEGER")
    if "lag_id" not in cols:
        # NULL means not part of a LAG.
        conn.execute("ALTER TABLE ports ADD COLUMN lag_id INTEGER")

    device_cols = {row["name"] for row in conn.execute("PRAGMA table_info(devices)").fetchall()}
    if "poe_required" not in device_cols:
        conn.execute("ALTER TABLE devices ADD COLUMN poe_required INTEGER NOT NULL DEFAULT 0")

    # Renamed "Workstation" role to "Client".
    conn.execute("UPDATE devices SET role = 'Client' WHERE role = 'Workstation'")
