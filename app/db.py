"""SQLite access layer."""

import json
import logging
import os
import shutil
import sqlite3
from contextlib import contextmanager

log = logging.getLogger("linkledger")

# Migrated to DB_PATH by init_db().
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

-- Picklist for devices.site; not a foreign key.
CREATE TABLE IF NOT EXISTS sites (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    name  TEXT NOT NULL UNIQUE
);

-- Uplinks for a virtual switch (AP Group / Virtual Switch); members are
-- tracked via ports.virtual_switch_id.
CREATE TABLE IF NOT EXISTS virtual_switch_uplinks (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    virtual_switch_id   INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    port_id             INTEGER NOT NULL UNIQUE REFERENCES ports(id) ON DELETE CASCADE
);

-- LAG member ports are tracked via ports.lag_id.
CREATE TABLE IF NOT EXISTS lags (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id   INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    UNIQUE(device_id, name)
);

-- One row per pfSense instance polled for ARP/DHCP data.
CREATE TABLE IF NOT EXISTS pfsense_instances (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    name                 TEXT NOT NULL,
    site                 TEXT NOT NULL DEFAULT '',
    base_url             TEXT NOT NULL,
    api_key              TEXT NOT NULL DEFAULT '',
    verify_tls           INTEGER NOT NULL DEFAULT 1,
    enabled              INTEGER NOT NULL DEFAULT 1,
    selected_interfaces  TEXT NOT NULL DEFAULT '[]',
    poll_minutes         INTEGER NOT NULL DEFAULT 20,
    last_sync_at         TEXT,
    last_sync_status     TEXT NOT NULL DEFAULT ''
);

-- MACs seen in pfSense ARP/DHCP data that aren't already claimed by a port.
CREATE TABLE IF NOT EXISTS discovered_devices (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    mac_address         TEXT NOT NULL UNIQUE,
    pfsense_instance_id INTEGER NOT NULL REFERENCES pfsense_instances(id) ON DELETE CASCADE,
    interface           TEXT NOT NULL DEFAULT '',
    dns_name            TEXT NOT NULL DEFAULT '',
    ip_address          TEXT NOT NULL DEFAULT '',
    first_seen          TEXT NOT NULL,
    last_seen           TEXT NOT NULL,
    status              TEXT NOT NULL DEFAULT 'pending'
);
"""

# Device roles offered in the UI.
ROLES = [
    "Switch", "Patch Panel", "Router/Firewall", "Hypervisor", "NAS",
    "Client", "Server", "Access Point", "Appliance", "AP Group",
    "Virtual Switch", "Internet", "Other",
]

# Roles that support VLAN tagging and "Supplies PoE" on their ports.
VLAN_POE_CAPABLE_ROLES = ["Switch", "Router/Firewall"]

# Roles that bridge all of their own ports together.
BRIDGING_ROLES = ["Switch", "Router/Firewall", "AP Group", "Virtual Switch"]

# Roles with no physical ports of their own.
VIRTUAL_SWITCH_ROLES = ["AP Group", "Virtual Switch"]

# Roles hidden from the Map tab by default.
MAP_HIDDEN_BY_DEFAULT_ROLES = ["Client", "Appliance", "Server"]


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
    except Exception:
        conn.rollback()
        raise
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
    if "grid_row" not in cols:
        # Only meaningful when port_layout_mode is 'custom'.
        conn.execute("ALTER TABLE ports ADD COLUMN grid_row INTEGER")
    if "grid_col" not in cols:
        conn.execute("ALTER TABLE ports ADD COLUMN grid_col INTEGER")
    if "mac_address" not in cols:
        # NULL means unknown. Normalized to uppercase colon-separated form.
        conn.execute("ALTER TABLE ports ADD COLUMN mac_address TEXT")
    # Allows any number of NULLs; non-NULL values must be unique.
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_ports_mac "
        "ON ports(mac_address) WHERE mac_address IS NOT NULL"
    )

    device_cols = {row["name"] for row in conn.execute("PRAGMA table_info(devices)").fetchall()}
    if "poe_required" not in device_cols:
        conn.execute("ALTER TABLE devices ADD COLUMN poe_required INTEGER NOT NULL DEFAULT 0")
    if "pos_x" not in device_cols:
        # NULL means not yet placed on the map.
        conn.execute("ALTER TABLE devices ADD COLUMN pos_x REAL")
    if "pos_y" not in device_cols:
        conn.execute("ALTER TABLE devices ADD COLUMN pos_y REAL")
    if "ports_per_row" not in device_cols:
        # NULL means all ports/positions in a single row.
        conn.execute("ALTER TABLE devices ADD COLUMN ports_per_row INTEGER")
    if "port_layout_mode" not in device_cols:
        # 'auto' wraps ports into rows of ports_per_row; 'custom' uses each
        # port's stored grid_row/grid_col.
        conn.execute("ALTER TABLE devices ADD COLUMN port_layout_mode TEXT NOT NULL DEFAULT 'auto'")
    if "show_on_map" not in device_cols:
        # Whether this device is drawn on the Map tab.
        conn.execute("ALTER TABLE devices ADD COLUMN show_on_map INTEGER NOT NULL DEFAULT 1")
        conn.execute("UPDATE devices SET show_on_map = 0 WHERE role = 'Client'")
    # One-time backfill, per role in MAP_HIDDEN_BY_DEFAULT_ROLES: hide
    # existing devices of that role from the map. 'Client' is skipped here
    # since it was already covered above when the show_on_map column itself
    # was created. Any role added to that list later picks up its own
    # catch-up backfill automatically instead of needing a new hardcoded block.
    for role in MAP_HIDDEN_BY_DEFAULT_ROLES:
        if role == "Client":
            continue
        meta_key = f"map_hide_{role.lower().replace(' ', '_')}_backfill"
        if conn.execute("SELECT 1 FROM meta WHERE key = ?", (meta_key,)).fetchone() is None:
            conn.execute("UPDATE devices SET show_on_map = 0 WHERE role = ?", (role,))
            conn.execute("INSERT INTO meta (key, value) VALUES (?, '1')", (meta_key,))

    # One-time backfill: "Devices missing a model" and "Ports missing a MAC
    # address" were added to the Reports tab after some installs may have
    # already narrowed their enabled-reports list via Settings. Without
    # this, those two reports would stay silently hidden forever on such an
    # install -- the user never got a chance to see and choose them.
    for report_key in ("missing_model", "missing_mac"):
        meta_key = f"reports_backfill_{report_key}"
        if conn.execute("SELECT 1 FROM meta WHERE key = ?", (meta_key,)).fetchone() is None:
            row = conn.execute("SELECT value FROM meta WHERE key = 'enabled_reports'").fetchone()
            if row and row["value"]:
                try:
                    saved = json.loads(row["value"])
                except (ValueError, TypeError):
                    saved = None
                if isinstance(saved, list) and report_key not in saved:
                    saved.append(report_key)
                    conn.execute(
                        "UPDATE meta SET value = ? WHERE key = 'enabled_reports'",
                        (json.dumps(saved),),
                    )
            conn.execute("INSERT INTO meta (key, value) VALUES (?, '1')", (meta_key,))

    conn.execute("UPDATE devices SET role = 'Client' WHERE role = 'Workstation'")
