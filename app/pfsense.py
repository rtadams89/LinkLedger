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
    interface -- the raw ifname (e.g. "lagg0.10"), the *assigned
    interface's* own description (e.g. "OPT1 (Workstations)", from
    /api/v2/interfaces), and -- confirmed against a real instance to be
    the actual gap -- a VLAN's *own* separate description (e.g.
    "10_WORKSTATIONS", from /api/v2/interface/vlans, RESTAPI\\Models\\
    InterfaceVLAN: if/tag/descr/vlanif) -- to the canonical raw ifname
    that instance["selected_interfaces"] stores (the same value
    list_interfaces() offers as a checkbox's value).

    These are two genuinely independent, independently-settable fields on
    two separate pfSense models (an assigned interface's own descr vs.
    the VLAN object's own descr for the VLAN it was created from), not
    one shared value -- a user can (and, in the field, does) name a VLAN
    "10_WORKSTATIONS" under Interfaces > VLANs while its interface
    assignment under Interfaces > Assignments keeps a different
    descr/no custom descr. pfSense's own ARP table reports the VLAN's own
    description for tagged traffic, so both sources are merged here
    rather than relying on just /api/v2/interfaces.

    Best-effort throughout: a PfsenseError fetching either endpoint just
    means that source contributes nothing to the map (the VLANs endpoint
    in particular may not exist on older package versions, or there may
    simply be no VLANs configured), rather than failing the whole sync."""
    name_map: dict[str, str] = {}
    try:
        data = _get(instance, "/api/v2/interfaces")
        rows = data.get("data", data) if isinstance(data, dict) else data
        for row in rows or []:
            raw = row.get("if") or row.get("name") or ""
            if not raw:
                continue
            name_map[raw] = raw
            descr = row.get("descr") or row.get("description") or ""
            if descr:
                name_map[descr] = raw
            ident = row.get("id") or ""
            if ident:
                name_map[ident] = raw
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
            name_map.setdefault(vlanif, vlanif)
            descr = row.get("descr") or row.get("description") or ""
            if descr:
                name_map[descr] = vlanif
    except PfsenseError:
        pass
    return name_map


def describe_arp_interfaces(instance: dict) -> dict:
    """Diagnostic-only helper: fetches the ARP table and reports, per
    *raw* interface value actually seen (before translation), how many
    rows had it and what _interface_name_map() translates it to --
    completely ignoring instance["selected_interfaces"] itself. Used by
    crud.sync_pfsense_instance to build a useful last_sync_status message
    whenever a sync's matched count doesn't cover every selected
    interface, since that's exactly the situation where a translation
    gap (vs. "that interface genuinely has no traffic right now") needs
    to be told apart -- e.g. if a VLAN sub-interface's *own* description
    (set under Interfaces > VLANs) differs from its *assigned interface's*
    description (set under Interfaces > Assignments, which is what
    /api/v2/interfaces -- and thus _interface_name_map() -- actually
    exposes), the raw value pfSense's ARP table reports for that VLAN
    won't be a key in the map at all, and translation silently falls
    back to passing the raw value through unchanged (see
    _interface_name_map()'s "best-effort" fallback) -- which then can't
    match a selected_interfaces entry that uses the *assignment's* name.
    Best-effort: callers should treat a PfsenseError here as "couldn't
    get a diagnosis" and fall back to a plain "ok", not as a sync
    failure."""
    name_map = _interface_name_map(instance)
    arp_data = _get(instance, "/api/v2/diagnostics/arp_table")
    arp_rows = arp_data.get("data", arp_data) if isinstance(arp_data, dict) else arp_data
    raw_counts: dict[str, int] = {}
    for row in arp_rows or []:
        raw_iface = row.get("interface") or row.get("if") or ""
        if raw_iface:
            raw_counts[raw_iface] = raw_counts.get(raw_iface, 0) + 1
    breakdown = [
        {"raw": raw, "translated": name_map.get(raw, raw), "count": count}
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
    ip_address, interface, hostname) gives MAC+IP+interface for anything
    currently on the wire; DHCP leases (RESTAPI\\Models\\DHCPServerLease:
    mac, ip, hostname, if) add a DNS name where one was handed out. A
    statically-addressed device with no lease still comes through from
    ARP alone -- using its own resolved hostname field, if any, before
    falling back to the DHCP lease's.

    A lease's own `hostname` field only gets populated when the client
    itself sends DHCP option 12 (client-hostname) -- plenty of real
    devices (several Apple product lines historically, Android, most
    IoT/embedded clients, and DHCPv6 clients in general) never send it,
    so that field legitimately comes back blank even for a device with a
    real, named lease. For a static DHCP mapping specifically, the
    human-entered name lives in the lease's separate `descr` field
    instead -- so that's included in the fallback chain too, below the
    client-sent hostname but above nothing (an unnamed dynamic lease for
    an option-12-silent client still has no name to show, which is
    correct -- there isn't one to find).

    The ARP table's "interface" field is translated through
    _interface_name_map() before comparing against selected_interfaces --
    confirmed against a real instance, pfSense can report that field as
    the interface's *description* (e.g. "10_WORKSTATIONS") rather than
    the raw ifname (e.g. "lagg0.10") the Settings picker's checkboxes use,
    depending on the box's `represent_interfaces_as` REST API setting.
    Without this translation every row silently fails to match and the
    sync reports "ok" with zero devices.
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
        iface = name_map.get(raw_iface, raw_iface)
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
            "dns_name": row.get("hostname") or lease.get("hostname") or lease.get("descr") or "",
        })
    return out
