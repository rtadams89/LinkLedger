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

-- One row per pfSense box LinkLedger polls for ARP/DHCP data (via the
-- third-party pfSense-pkg-API package -- pfSense itself has no native
-- REST API). A real list rather than a single meta-blob setting because a
-- household/homelab can have more than one site, each with its own
-- pfSense instance. `site` is free-text, matching the devices.site
-- convention (no FK) -- used to pre-fill a discovered device's Site field
-- on import and to group/filter the Discovery view.
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

-- Staging list of MACs seen in a pfSense instance's ARP/DHCP data that
-- aren't already claimed by a port (see idx_ports_mac above). Refreshed
-- on every sync rather than accumulated forever -- see
-- crud.sync_pfsense_instance. IP/DNS name here are transient, sourced
-- live from pfSense's own DHCP leases -- LinkLedger does not otherwise
-- track L3 anywhere.
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

# Roles hidden from the Map tab by default (still toggleable per device,
# see devices.show_on_map) because there tend to be a lot of them and
# they clutter the diagram: personal client devices, small smart-home/IoT
# appliances, and general-purpose servers (VMs, containers, etc. tend to
# pile up fast and rarely need to appear on the physical topology view).
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
        # Free-form port-layout grid position, only meaningful while the
        # owning device's port_layout_mode is 'custom' (see below) -- NULL
        # until the device is switched into custom mode or a new port is
        # added to a device that's already in it (see crud.set_port_layout_mode
        # / crud._next_custom_grid_slot for how a NULL position gets a
        # sensible fallback at render/edit time).
        conn.execute("ALTER TABLE ports ADD COLUMN grid_row INTEGER")
    if "grid_col" not in cols:
        conn.execute("ALTER TABLE ports ADD COLUMN grid_col INTEGER")
    if "mac_address" not in cols:
        # NULL means unknown/not recorded. Normalized to uppercase
        # colon-separated form by crud.set_port_mac. Layer 2 only --
        # LinkLedger deliberately does not track IP/L3 anywhere.
        conn.execute("ALTER TABLE ports ADD COLUMN mac_address TEXT")
    # Partial unique index so two ports can't claim the same MAC, while
    # any number of NULLs (unknown) is fine. Re-run every migration --
    # CREATE ... IF NOT EXISTS is a no-op once it's there.
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
        # 'auto' wraps ports into rows of ports_per_row, same as always.
        # 'custom' instead renders each port/pair at its own stored
        # ports.grid_row/grid_col -- a free-form grid edited per device
        # (see crud.set_port_layout_mode / set_port_grid_positions).
        conn.execute("ALTER TABLE devices ADD COLUMN port_layout_mode TEXT NOT NULL DEFAULT 'auto'")
    if "show_on_map" not in device_cols:
        # Whether this device is drawn on the Map tab. Defaults to visible,
        # except we immediately hide any existing Client devices below --
        # new devices get the same role-based default from crud.create_device.
        conn.execute("ALTER TABLE devices ADD COLUMN show_on_map INTEGER NOT NULL DEFAULT 1")
        conn.execute("UPDATE devices SET show_on_map = 0 WHERE role = 'Client'")
    # Appliance (smart-home/IoT) devices joined the default-hidden set
    # after the column above already existed for some installs, so this
    # gets its own one-time backfill (via the meta table) instead of
    # folding into the show_on_map column-add branch, which only ever
    # runs once, at column-creation time.
    if conn.execute("SELECT 1 FROM meta WHERE key = 'map_hide_appliance_backfill'").fetchone() is None:
        conn.execute("UPDATE devices SET show_on_map = 0 WHERE role = 'Appliance'")
        conn.execute("INSERT INTO meta (key, value) VALUES ('map_hide_appliance_backfill', '1')")
    # Same deal for Server -- joined the default-hidden set later still,
    # so it gets its own one-time backfill rather than retroactively
    # changing what the Appliance backfill above already did.
    if conn.execute("SELECT 1 FROM meta WHERE key = 'map_hide_server_backfill'").fetchone() is None:
        conn.execute("UPDATE devices SET show_on_map = 0 WHERE role = 'Server'")
        conn.execute("INSERT INTO meta (key, value) VALUES ('map_hide_server_backfill', '1')")

    # Renamed "Workstation" role to "Client".
    conn.execute("UPDATE devices SET role = 'Client' WHERE role = 'Workstation'")
