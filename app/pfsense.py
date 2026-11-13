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
    """
    import json as _json

    selected = set(_json.loads(instance.get("selected_interfaces") or "[]"))
    if not selected:
        return []

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
        iface = row.get("interface") or row.get("if") or ""
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
            "dns_name": row.get("hostname") or lease.get("hostname") or "",
        })
    return out
