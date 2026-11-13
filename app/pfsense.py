"""Thin HTTP client for pfSense's ARP table / DHCP leases, used by the
device-discovery feature (see crud.sync_pfsense_instance).

pfSense itself has no native REST API. Everything here goes through the
third-party community package **pfSense-pkg-RESTAPI**
(https://github.com/pfrest/pfSense-pkg-RESTAPI, docs at https://pfrest.org/
-- formerly "pfsense-api" under jaredhendrickson13, now moved to its own
pfrest org/domain), which the user installs on each pfSense box themselves
(via `pkg-static add <release .pkg URL>`, not the System > Package Manager
GUI -- see the README/Help for the exact command) and configures under
System > REST API (enable it, choose Key auth) / System > REST API > Keys
(generate a key) in the pfSense GUI. LinkLedger just consumes it.

Every pfSense-specific endpoint path / auth header / response shape is
kept behind the three functions below so it's one place to adjust as we
test against real instances. Confirmed against the v2 API docs
(https://pfrest.org/AUTHENTICATION_AND_AUTHORIZATION/ and the RESTAPI\\
Models\\ARPTable / DHCPServerLease / NetworkInterface(s) PHP docs): key
auth goes in an `X-API-Key` header (raw key, no "Bearer"/"Basic" prefix --
those are for the separate Basic/JWT auth modes), and the interfaces
endpoint is `/api/v2/interfaces` (plural).

Uses `requests` (sync) rather than an async client: every route handler in
app/main.py is a plain sync `def` run in FastAPI's threadpool, so a sync
HTTP call fits the rest of the app without pulling in asyncio machinery
just for this.
"""

import requests

# Most pfSense GUIs (and the API package riding on the same cert) are
# self-signed, hence verify_tls being a per-instance opt-out rather than
# always-on. requests warns loudly about unverified HTTPS; let the user's
# own verify_tls=False choice be a quiet, deliberate one.
requests.packages.urllib3.disable_warnings(requests.packages.urllib3.exceptions.InsecureRequestWarning)

DEFAULT_TIMEOUT = 15


class PfsenseError(Exception):
    """Raised for anything that stops us from reaching/trusting the
    instance -- connection failure, auth failure, unexpected response
    shape. The caller (crud.sync_pfsense_instance / the API layer) turns
    this into a user-facing message rather than a stack trace."""


def _headers(instance: dict) -> dict:
    # pfSense-pkg-RESTAPI's key-auth mode: the raw key goes in an X-API-Key
    # header, no "Bearer"/"Basic" prefix -- that prefix is only for the
    # package's separate Basic-auth (local account) and JWT auth modes.
    # See https://pfrest.org/AUTHENTICATION_AND_AUTHORIZATION/.
    return {"X-API-Key": instance["api_key"], "Accept": "application/json"}


def _get(instance: dict, path: str, params: dict | None = None):
    url = instance["base_url"].rstrip("/") + path
    try:
        resp = requests.get(
            url, headers=_headers(instance), params=params,
            verify=bool(instance.get("verify_tls", True)), timeout=DEFAULT_TIMEOUT,
        )
    except requests.RequestException as e:
        raise PfsenseError(f"couldn't reach {instance['name']} at {url}: {e}")
    if resp.status_code == 401 or resp.status_code == 403:
        raise PfsenseError(f"{instance['name']} rejected the API key (HTTP {resp.status_code})")
    if resp.status_code >= 400:
        raise PfsenseError(f"{instance['name']} returned HTTP {resp.status_code} for {path}")
    try:
        return resp.json()
    except ValueError:
        raise PfsenseError(f"{instance['name']} didn't return JSON for {path}")


def test_connection(instance: dict) -> None:
    """Raises PfsenseError if the instance can't be reached or the API key
    is rejected. Used by the Settings "Test connection" button."""
    _get(instance, "/api/v2/status/system")


def list_interfaces(instance: dict) -> list[dict]:
    """Physical interfaces + VLAN sub-interfaces, for the Settings page's
    interface picker. Returns [{"name": "igb0.100", "label": "..."}]."""
    data = _get(instance, "/api/v2/interfaces")
    rows = data.get("data", data) if isinstance(data, dict) else data
    out = []
    for row in rows or []:
        name = row.get("if") or row.get("name") or ""
        if not name:
            continue
        descr = row.get("descr") or row.get("description") or ""
        out.append({"name": name, "label": f"{name} ({descr})" if descr else name})
    return out


def _interface_name_map(instance: dict) -> dict:
    """Maps every representation pfSense might use to identify an
    interface to the canonical raw ifname that
    instance["selected_interfaces"] stores (the same value
    list_interfaces() offers as a checkbox's value): the raw ifname itself
    (e.g. "lagg0.10"), the assigned interface's own `id` (e.g. "opt4"),
    and its own `descr` (e.g. "10_workstations", from /api/v2/interfaces)
    -- plus, for VLANs specifically, the VLAN object's own separate descr
    (from /api/v2/interface/vlans, RESTAPI\\Models\\InterfaceVLAN), kept
    as a second, independent source since it's a genuinely different
    field a user could have set differently.

    Confirmed against a real instance: pfSense's ARP table reports an
    interface by its *assigned interface's own descr, forced to
    UPPERCASE* ("10_workstations" in /api/v2/interfaces becomes
    "10_WORKSTATIONS" in the ARP table) -- not by matching case, and not
    by the VLAN's own separate descr at all. So every key this function
    adds is normalized with .upper() at insertion, and every lookup
    against this map must do the same (see describe_arp_interfaces() /
    fetch_arp_and_leases() below) -- a case-sensitive match would silently
    drop every VLAN whose descr isn't already all-caps, exactly like the
    one already-uppercase "1_LAN" interface matched while every
    lowercase-suffixed VLAN descr (the common case) silently didn't.

    Best-effort throughout: a PfsenseError fetching either endpoint just
    means that source contributes nothing to the map (the VLANs endpoint
    in particular may not exist on older package versions, or there may
    simply be no VLANs configured), rather than failing the whole sync."""
    name_map: dict[str, str] = {}

    def add(key: str, target: str) -> None:
        if key:
            name_map[key.upper()] = target

    try:
        data = _get(instance, "/api/v2/interfaces")
        rows = data.get("data", data) if isinstance(data, dict) else data
        for row in rows or []:
            raw = row.get("if") or row.get("name") or ""
            if not raw:
                continue
            add(raw, raw)
            add(row.get("descr") or row.get("description") or "", raw)
            add(row.get("id") or "", raw)
    except PfsenseError:
        pass
    try:
        vlan_data = _get(instance, "/api/v2/interface/vlans")
        vlan_rows = vlan_data.get("data", vlan_data) if isinstance(vlan_data, dict) else vlan_data
        for row in vlan_rows or []:
            # vlanif is the VLAN's own real interface identifier (e.g.
            # "lagg0.10", auto-populated by pfSense from if+tag) -- use it
            # directly as the canonical target rather than requiring it to
            # also appear in /api/v2/interfaces, so this still works even
            # for a VLAN that was never assigned to an OPT slot.
            vlanif = row.get("vlanif") or ""
            if not vlanif:
                continue
            add(vlanif, vlanif)
            add(row.get("descr") or row.get("description") or "", vlanif)
    except PfsenseError:
        pass
    return name_map


def _translate_interface(name_map: dict, raw_iface: str) -> str:
    """Looks up a raw ARP/interface value against _interface_name_map()'s
    output case-insensitively (see that function's docstring for why --
    pfSense's ARP table uppercases the assigned interface's descr before
    reporting it). Falls back to the raw value unchanged when there's no
    match, same as a plain dict.get() would."""
    return name_map.get(raw_iface.upper(), raw_iface) if raw_iface else raw_iface


def describe_arp_interfaces(instance: dict) -> dict:
    """Diagnostic-only helper: fetches the ARP table and reports, per
    *raw* interface value actually seen (before translation), how many
    rows had it and what _interface_name_map() translates it to --
    completely ignoring instance["selected_interfaces"] itself. Used by
    crud.sync_pfsense_instance to build a useful last_sync_status message
    whenever a sync's matched count doesn't cover every selected
    interface, since that's exactly the situation where a translation
    gap (vs. "that interface genuinely has no traffic right now") needs
    to be told apart. Best-effort: callers should treat a PfsenseError
    here as "couldn't get a diagnosis" and fall back to a plain "ok", not
    as a sync failure."""
    name_map = _interface_name_map(instance)
    arp_data = _get(instance, "/api/v2/diagnostics/arp_table")
    arp_rows = arp_data.get("data", arp_data) if isinstance(arp_data, dict) else arp_data
    raw_counts: dict[str, int] = {}
    for row in arp_rows or []:
        raw_iface = row.get("interface") or row.get("if") or ""
        if raw_iface:
            raw_counts[raw_iface] = raw_counts.get(raw_iface, 0) + 1
    breakdown = [
        {"raw": raw, "translated": _translate_interface(name_map, raw), "count": count}
        for raw, count in sorted(raw_counts.items())
    ]
    return {
        "total": len(arp_rows or []),
        "interfaces": sorted({b["translated"] for b in breakdown}),
        "breakdown": breakdown,
    }


def fetch_arp_and_leases(instance: dict) -> list[dict]:
    """Returns [{"mac": "AA:BB:...", "interface": "igb0.100", "ip": "...",
    "dns_name": "..."}], filtered to instance["selected_interfaces"] (a
    JSON-encoded list of interface names; empty/unset means "no
    interfaces chosen yet" -> returns nothing, rather than everything, so
    a freshly-added instance doesn't flood the Discovery view before the
    user picks what they actually want).

    Joined by MAC: the ARP table (RESTAPI\\Models\\ARPTable: mac_address,
    ip_address, interface, dnsresolve) gives MAC+IP+interface for anything
    currently on the wire; DHCP leases (RESTAPI\\Models\\DHCPServerLease:
    mac, ip, hostname, descr, if) add a DNS name where one was handed
    out. A statically-addressed device with no lease still comes through
    from ARP alone -- using its own resolved name, if any, before falling
    back to the DHCP lease's.

    Confirmed against a real instance: an ARP row's `hostname` field is
    NOT a useful name at all -- it's always the literal placeholder
    string "?", regardless of the device. The actual reverse-resolved
    name (when pfSense has one) is in a differently-named field,
    `dnsresolve`. `hostname` is deliberately never read here as a result
    -- reading it was the original bug (every row silently got "?" as its
    dns_name, which displays as truthy-but-useless rather than the clean
    blank a real lack-of-name should show). A lease's own `hostname`
    field is a different, legitimate field (populated only when the
    client sends DHCP option 12, so plenty of real devices leave it
    blank) and a static mapping's human-entered name lives in the lease's
    `descr` instead -- both still used as fallbacks below `dnsresolve`.

    The ARP table's "interface" field is translated through
    _interface_name_map() before comparing against selected_interfaces --
    confirmed against a real instance, pfSense reports that field as the
    assigned interface's own description *forced to uppercase*, so the
    translation (and lookup here) is case-insensitive; see
    _interface_name_map()'s docstring. Without this translation every row
    silently fails to match and the sync reports "ok" with zero devices.
    """
    import json as _json

    selected = set(_json.loads(instance.get("selected_interfaces") or "[]"))
    if not selected:
        return []

    name_map = _interface_name_map(instance)

    arp_data = _get(instance, "/api/v2/diagnostics/arp_table")
    arp_rows = arp_data.get("data", arp_data) if isinstance(arp_data, dict) else arp_data

    lease_data = _get(instance, "/api/v2/status/dhcp_server/leases")
    lease_rows = lease_data.get("data", lease_data) if isinstance(lease_data, dict) else lease_data
    leases_by_mac = {}
    for row in lease_rows or []:
        mac = (row.get("mac") or "").strip().upper()
        if mac:
            leases_by_mac[mac] = row

    out = []
    for row in arp_rows or []:
        raw_iface = row.get("interface") or row.get("if") or ""
        iface = _translate_interface(name_map, raw_iface)
        if iface not in selected:
            continue
        mac = (row.get("mac_address") or row.get("mac") or "").strip().upper()
        if not mac:
            continue
        lease = leases_by_mac.get(mac, {})
        out.append({
            "mac": mac,
            "interface": iface,
            "ip": row.get("ip_address") or row.get("ip") or "",
            "dns_name": row.get("dnsresolve") or lease.get("hostname") or lease.get("descr") or "",
        })
    return out
