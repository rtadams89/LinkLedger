"""HTTP client for pfSense's ARP table and DHCP leases, via the
pfSense-pkg-RESTAPI package."""

import warnings

import requests
from urllib3.exceptions import InsecureRequestWarning

DEFAULT_TIMEOUT = 15


class PfsenseError(Exception):
    """Raised when a pfSense instance can't be reached or trusted."""


def _headers(instance: dict) -> dict:
    return {"X-API-Key": instance["api_key"], "Accept": "application/json"}


def _get(instance: dict, path: str, params: dict | None = None):
    url = instance["base_url"].rstrip("/") + path
    verify = bool(instance.get("verify_tls", True))
    try:
        with warnings.catch_warnings():
            if not verify:
                # Only silence the warning for this one deliberately-insecure
                # call, not for every request the process makes.
                warnings.simplefilter("ignore", InsecureRequestWarning)
            resp = requests.get(
                url, headers=_headers(instance), params=params,
                verify=verify, timeout=DEFAULT_TIMEOUT,
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
    """Raises PfsenseError if unreachable or the API key is rejected."""
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
    """Maps interface identifiers (ifname, id, descr, VLAN descr) to the
    canonical ifname, with keys uppercased."""
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
            vlanif = row.get("vlanif") or ""
            if not vlanif:
                continue
            add(vlanif, vlanif)
            add(row.get("descr") or row.get("description") or "", vlanif)
    except PfsenseError:
        pass
    return name_map


def _translate_interface(name_map: dict, raw_iface: str) -> str:
    """Looks up raw_iface in name_map case-insensitively, falling back to
    raw_iface if there's no match."""
    return name_map.get(raw_iface.upper(), raw_iface) if raw_iface else raw_iface


def describe_arp_interfaces(instance: dict) -> dict:
    """Returns row counts and translated names for every raw interface
    value seen in the ARP table."""
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
    """Returns [{"mac", "interface", "ip", "dns_name"}] for
    instance["selected_interfaces"]; an empty selection returns []."""
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
        mac = (row.get("mac_address") or row.get("mac") or "").strip().upper()
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
