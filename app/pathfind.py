"""Find the physical/logical path between two devices.

Graph model, built fresh from the current DB on every query (this is a
homelab-scale dataset -- tens of devices, at most a few hundred ports --
so there's no need to cache it):

- Every port is a graph node.
- A cable between two ports is a real edge (carries the two ports' speeds,
  so the segment's effective speed can be shown).
- A "pair" link (patch panel front/rear pass-through, or any manually
  paired ports) is a real edge -- these only ever connect the two specific
  ports that were paired.
- A Switch or Router/Firewall device bridges ALL of its own ports to each
  other -- this represents pure physical cabling connectivity through the
  device, the same as any real switch/router backplane.
- Any other device role (NAS, workstation, appliance, etc.) does NOT
  bridge between its own ports -- a NAS's three NICs can't reach each
  other through the NAS.
- An AP Group / Virtual Switch device (db.VIRTUAL_SWITCH_ROLES) has no
  physical ports of its own. It gets one synthetic graph node instead,
  bridged to: its uplinks (real ports elsewhere that keep their own normal
  cable too -- an access point's wired port, a hypervisor's physical NIC)
  and its members (ports whose ONLY connection is to it instead of a
  cable -- a wireless client's NIC, a VM/container's vNIC). By default this
  lets a wireless client reach the network through WHICHEVER of several
  APs gives the shortest route, and lets a VM/container's traffic be
  traced through its host(s) -- including a container inside a VM, which
  is just two of these chained together. The caller can also pin a
  specific search to one particular uplink (e.g. "assume this laptop is on
  AP2, not whichever AP is closest") via uplink_a_id/uplink_b_id below --
  see find_path().

VLANs are handled as a SEARCH CONSTRAINT, not by removing edges from the
graph above. If the two NICs being searched between are on explicitly
tagged VLANs that don't overlap, a Switch (or AP Group / Virtual Switch)
alone can't legitimately bridge them -- so the search specifically requires
the path to pass through at least one Router/Firewall device (comparing
every combination of "shortest way to reach some router" + "shortest way
from that router to the destination", and picking the best one). If the two
NICs share a VLAN, or either end is untagged (VLAN tagging is optional, so
most ports won't have it set), a plain shortest path is used with no such
requirement. Either way, if no path satisfying the requirement exists, "no
path found" is returned rather than a route that wouldn't actually carry
the traffic. A port's own VLAN tag (if set directly on it, the same field a
switch port uses) takes priority over inferring one by tracing outward --
this is what a wireless client or VM/container vNIC uses to record which
VLAN it's actually on, since there's no wire to trace back to a switch.

To let the caller pick two DEVICES rather than two specific ports, "start"
is any port of device A and "end" is any port of device B; the search
picks whichever ports give the shortest valid path.
"""

from collections import defaultdict, deque

from . import crud, db


def _vs_node(virtual_switch_id: int) -> str:
    """Synthetic graph node key for an AP Group / Virtual Switch device --
    a string so it can never collide with a real port id (always an int)."""
    return f"vs:{virtual_switch_id}"


def _build_graph(conn, forced_uplinks=None, exclude_vs_ids=None):
    """forced_uplinks: optional {virtual_switch_device_id: uplink_port_id}
    -- when a virtual switch's id is present, only ITS forced uplink port
    gets an edge to/from the synthetic node, instead of every uplink it
    has. This is how a search can be pinned to one specific AP/uplink
    instead of leaving it to BFS to (implicitly) pick whichever one comes
    first in a tie. Any other virtual switch not mentioned here is
    unaffected -- still bridged to all of its own uplinks as usual.

    exclude_vs_ids: optional set of virtual_switch_device_id values to
    completely omit from the graph -- neither their uplink edges NOR their
    member edges get added, so the synthetic node doesn't exist at all as
    far as BFS is concerned. Used to find the real backbone path between
    two of a shared AP Group's uplinks without the trivial "both ends are
    members of the same AP Group, 2 hops" shortcut being available -- see
    the "split" handling in find_path()."""
    forced_uplinks = forced_uplinks or {}
    exclude_vs_ids = exclude_vs_ids or set()
    port_rows = conn.execute(
        "SELECT ports.*, devices.role AS device_role, devices.name AS device_name "
        "FROM ports JOIN devices ON devices.id = ports.device_id"
    ).fetchall()
    ports = {row["id"]: dict(row) for row in port_rows}

    devices = {d["id"]: d for d in crud.list_devices(conn)}

    by_device = defaultdict(list)
    for pid, p in ports.items():
        by_device[p["device_id"]].append(pid)

    adj = defaultdict(list)  # node -> [(neighbor, edge_type, speed)]

    for c in conn.execute("SELECT * FROM cables").fetchall():
        a, b = c["port_a_id"], c["port_b_id"]
        pa, pb = ports.get(a), ports.get(b)
        speeds = [p["speed"] for p in (pa, pb) if p and p["speed"]]
        seg_speed = min(speeds, key=lambda s: crud.SPEED_MBPS.get(s, 0)) if speeds else None
        adj[a].append((b, "cable", seg_speed))
        adj[b].append((a, "cable", seg_speed))

    for pid, p in ports.items():
        if p["pair_port_id"] and p["pair_port_id"] in ports:
            adj[pid].append((p["pair_port_id"], "pass-through", None))

    for dev_id, port_ids in by_device.items():
        role = devices.get(dev_id, {}).get("role")
        if role in db.BRIDGING_ROLES:
            for i in range(len(port_ids)):
                for j in range(i + 1, len(port_ids)):
                    adj[port_ids[i]].append((port_ids[j], "backbone", None))
                    adj[port_ids[j]].append((port_ids[i], "backbone", None))

    # AP Group / Virtual Switch devices: one synthetic node each, bridged to
    # their uplinks (real ports that keep their own normal cable too) and
    # their members (ports whose only connection is this virtual switch).
    for dev_id, dev in devices.items():
        if dev.get("role") not in db.VIRTUAL_SWITCH_ROLES:
            continue
        if dev_id in exclude_vs_ids:
            continue  # this virtual switch's node is entirely excluded from the graph
        node = _vs_node(dev_id)
        forced_port = forced_uplinks.get(dev_id)
        for u in crud.list_uplinks(conn, dev_id):
            pid = u["port_id"]
            if forced_port is not None and pid != forced_port:
                continue  # pinned to a different uplink -- leave this one out of the graph
            adj[node].append((pid, "virtual-uplink", None))
            adj[pid].append((node, "virtual-uplink", None))
    for pid, p in ports.items():
        if p["virtual_switch_id"] and p["virtual_switch_id"] not in exclude_vs_ids:
            node = _vs_node(p["virtual_switch_id"])
            adj[node].append((pid, "virtual-link", None))
            adj[pid].append((node, "virtual-link", None))

    return ports, devices, by_device, adj


def _effective_vlan_set(conn, ports, port_ids):
    """A port's own VLAN tag (same field a switch port uses) takes priority
    -- this is how a wireless client or VM/container vNIC records which
    VLAN it's on, since there's no wire to trace back to a switch for it.
    Falls back to tracing outward for a wired port that doesn't carry its
    own tag, same as before."""
    vlans = set()
    for pid in port_ids:
        direct = (ports.get(pid, {}).get("vlans") or "").strip()
        v = direct if direct else crud.effective_vlans(crud.trace(conn, pid))
        for tag in v.split(","):
            tag = tag.strip()
            if tag:
                vlans.add(tag)
    return vlans


def _bfs_dist(adj, sources):
    """Multi-source BFS: every port in `sources` starts at distance 0 (no
    virtual sentinel node needed). Returns (dist, prev) where dist[node] is
    the hop count from the nearest source, and prev[node] is
    (predecessor, edge_type, speed) -- or None for the sources themselves."""
    dist = {}
    prev = {}
    q = deque()
    for pid in sources:
        if pid not in dist:
            dist[pid] = 0
            prev[pid] = None
            q.append(pid)
    while q:
        node = q.popleft()
        for neighbor, etype, speed in adj.get(node, []):
            if neighbor not in dist:
                dist[neighbor] = dist[node] + 1
                prev[neighbor] = (node, etype, speed)
                q.append(neighbor)
    return dist, prev


def _walk_to_root(prev, node):
    """Walks prev[] from `node` back to its BFS root (prev value None),
    returning [root, ..., node] in root-to-node order."""
    chain = []
    while node is not None:
        chain.append(node)
        entry = prev.get(node)
        node = entry[0] if entry else None
    chain.reverse()
    return chain


def find_path(conn, device_a_id: int, device_b_id: int,
              port_a_id: int | None = None, port_b_id: int | None = None,
              uplink_a_id: int | None = None, uplink_b_id: int | None = None) -> dict:
    """If port_a_id/port_b_id are given, the search starts/ends at exactly
    that NIC -- important for a device with more than one port, where
    otherwise the shortest path might come back via a NIC the caller wasn't
    thinking of (e.g. a storage NIC instead of the main LAN NIC). Leaving
    either one out falls back to "any port on this device", which is looser
    but still useful for a quick check.

    uplink_a_id/uplink_b_id are optional and only meaningful when the
    corresponding chosen NIC is a virtual link member of an AP Group /
    Virtual Switch (ports.virtual_switch_id set) -- by default the search
    lets BFS pick whichever of that virtual switch's uplinks gives the
    shortest route, same as always, which in practice means it's always
    the SAME uplink for a given pair of endpoints even if the device could
    plausibly reach the network through a different one right now (e.g. a
    laptop that's actually associated to AP2, not AP1). Passing the
    relevant uplink's port id here pins the search to exactly that one
    instead. Raises ConflictError if the named NIC isn't such a member, or
    if the uplink doesn't belong to that virtual switch.

    If uplink_a_id and uplink_b_id name two DIFFERENT uplinks on the very
    same virtual switch (e.g. two wireless clients in one AP Group, each
    actually associated to a different physical AP), that's not an error --
    it's treated as a request for the real backbone path between those two
    specific uplinks, bypassing the shared AP Group / Virtual Switch's
    trivial "both are members, 2 hops" shortcut entirely. If no such
    backbone path exists, "not found" is returned rather than falling back
    to that shortcut."""
    device_a = crud.get_device(conn, device_a_id)
    device_b = crud.get_device(conn, device_b_id)
    if device_a_id == device_b_id:
        raise crud.ConflictError("pick two different devices")

    ports, devices, by_device, adj = _build_graph(conn)

    if port_a_id is not None:
        p = ports.get(port_a_id)
        if not p or p["device_id"] != device_a_id:
            raise crud.ConflictError("that source port doesn't belong to device A")
        start_ports = [port_a_id]
    else:
        start_ports = by_device.get(device_a_id, [])

    if port_b_id is not None:
        p = ports.get(port_b_id)
        if not p or p["device_id"] != device_b_id:
            raise crud.ConflictError("that destination port doesn't belong to device B")
        end_ports = [port_b_id]
    else:
        end_ports = by_device.get(device_b_id, [])

    if not start_ports:
        return {"found": False, "device_a": device_a, "device_b": device_b,
                "reason": f"{device_a['name']} has no ports yet"}
    if not end_ports:
        return {"found": False, "device_a": device_a, "device_b": device_b,
                "reason": f"{device_b['name']} has no ports yet"}

    # Optional pin to one specific uplink of a virtual switch the chosen
    # NIC is a member of (see docstring above). Validated against `ports`
    # from the unrestricted graph build above.
    def _resolve_pin(label, chosen_port_id, uplink_id):
        """Returns (vs_id, uplink_port_id) for a valid pin, or None if
        uplink_id wasn't given. Raises ConflictError only for a genuinely
        invalid pin -- the chosen NIC isn't a virtual-switch member, or the
        named uplink doesn't belong to that virtual switch. A *shared*
        virtual switch pinned to two different uplinks from each side isn't
        an error here -- see the "split" handling below."""
        if uplink_id is None:
            return None
        p = ports.get(chosen_port_id) if chosen_port_id is not None else None
        vs_id = p["virtual_switch_id"] if p else None
        if not vs_id:
            raise crud.ConflictError(
                f"{label}'s NIC isn't wirelessly/virtually linked to an AP Group or "
                "Virtual Switch, so there's no uplink to pin it to"
            )
        uplink_port_ids = {u["port_id"] for u in crud.list_uplinks(conn, vs_id)}
        if uplink_id not in uplink_port_ids:
            raise crud.ConflictError(
                "that uplink doesn't belong to the AP Group / Virtual Switch this NIC is linked to"
            )
        return vs_id, uplink_id

    pin_a = _resolve_pin(device_a["name"], port_a_id, uplink_a_id)
    pin_b = _resolve_pin(device_b["name"], port_b_id, uplink_b_id)

    # Split scenario: both sides pinned to DIFFERENT uplinks of the SAME AP
    # Group / Virtual Switch -- e.g. two wireless clients in one AP Group,
    # each actually associated to a different physical AP on a different
    # switch. That's a meaningful, well-formed question ("what's the real
    # backbone path between these two specific APs?"), so instead of
    # rejecting it, it's handled by the `split` branch below: each side's
    # member->AP hop is fixed/known, and only the backbone between the two
    # uplinks needs a real search.
    split = None
    forced_uplinks = {}
    if pin_a and pin_b and pin_a[0] == pin_b[0] and pin_a[1] != pin_b[1]:
        split = pin_a[0], pin_a[1], pin_b[1]
    else:
        for pin in (pin_a, pin_b):
            if pin:
                forced_uplinks[pin[0]] = pin[1]

    # VLAN(s) actually carried by the chosen NIC(s) -- used both for the
    # informational note below and to decide whether the search needs to
    # require a Router/Firewall hop. Computed from the original (row-data
    # only) `ports` dict, so it's unaffected by whichever graph variant
    # ends up getting searched below.
    vlans_a = _effective_vlan_set(conn, ports, start_ports)
    vlans_b = _effective_vlan_set(conn, ports, end_ports)
    require_router = bool(vlans_a) and bool(vlans_b) and not (vlans_a & vlans_b)

    port_path = None
    combined_prev = None
    edges_into = None  # (edge_type, speed) aligned 1:1 with port_path; index 0 is always None

    if split:
        # The member->AP hop on each side is unconditional/known (every
        # virtual-switch member always has an edge to its vs_node, and
        # every uplink always has one too) -- no BFS needed for those. Only
        # the backbone in between needs a real search, and it has to run on
        # a graph that fully excludes this shared vs_node (both its member
        # AND uplink edges) -- otherwise BFS would just walk straight back
        # through the AP Group itself, the trivial 2-hop shortcut this
        # whole branch exists to avoid.
        vs_id, uplink_a_port, uplink_b_port = split
        _, _, _, excluded_adj = _build_graph(conn, exclude_vs_ids={vs_id})
        dist_mid, prev_mid = _bfs_dist(excluded_adj, [uplink_a_port])
        if uplink_b_port not in dist_mid:
            return {"found": False, "device_a": device_a, "device_b": device_b,
                    "reason": ("no cabled backbone path exists between the two APs/uplinks "
                               "these devices are pinned to (the shared AP Group / Virtual "
                               "Switch itself is excluded from this search, since routing "
                               "through it wouldn't reflect the actual physical path)")}
        backbone = _walk_to_root(prev_mid, uplink_b_port)  # [uplink_a_port, ..., uplink_b_port]

        vs_node = _vs_node(vs_id)
        port_path = [port_a_id, vs_node] + backbone + [vs_node, port_b_id]
        edges_into = [None, ("virtual-link", None), ("virtual-uplink", None)]
        for i in range(1, len(backbone)):
            _, etype, speed = prev_mid[backbone[i]]
            edges_into.append((etype, speed))
        edges_into.append(("virtual-uplink", None))
        edges_into.append(("virtual-link", None))
    else:
        if forced_uplinks:
            ports, devices, by_device, adj = _build_graph(conn, forced_uplinks)

        dist_s, prev_s = _bfs_dist(adj, start_ports)

        if not require_router:
            reachable_ends = [p for p in end_ports if p in dist_s]
            if reachable_ends:
                best_end = min(reachable_ends, key=lambda p: dist_s[p])
                port_path = _walk_to_root(prev_s, best_end)
                combined_prev = prev_s
        else:
            # A Switch alone can't bridge two different VLANs -- the path has
            # to go through some Router/Firewall device. Find the router port
            # that minimizes (distance from start to it) + (distance from it
            # to end); the router's own backbone edges already account for
            # entering on one of its ports and leaving on another.
            router_ports = [
                pid for dev_id, pids in by_device.items()
                if devices.get(dev_id, {}).get("role") == "Router/Firewall"
                for pid in pids
            ]
            if router_ports:
                dist_e, prev_e = _bfs_dist(adj, end_ports)
                best_port, best_total = None, None
                for rp in router_ports:
                    if rp in dist_s and rp in dist_e:
                        total = dist_s[rp] + dist_e[rp]
                        if best_total is None or total < best_total:
                            best_total, best_port = total, rp
                if best_port is not None:
                    left = _walk_to_root(prev_s, best_port)  # [start_port, ..., best_port]
                    right = _walk_to_root(prev_e, best_port)  # [end_port, ..., best_port]
                    right.reverse()  # [best_port, ..., end_port]
                    port_path = left + right[1:]
                    combined_prev = dict(prev_s)
                    for i in range(len(right) - 1):
                        a, b = right[i], right[i + 1]  # a closer to the router, b closer to end
                        _, etype, speed = prev_e[a]
                        combined_prev[b] = (a, etype, speed)

        if port_path is None:
            reason = ("no cabled path through a Router/Firewall device exists between these two "
                      "VLANs" if require_router else "no cabled path exists between these two devices")
            return {"found": False, "device_a": device_a, "device_b": device_b, "reason": reason}

        edges_into = [None]
        for n in port_path[1:]:
            edge = combined_prev.get(n)
            edges_into.append((edge[1], edge[2]) if edge else None)

    # group consecutive same-device nodes into segments -- a node is either
    # a real port (int id) or a virtual switch's synthetic node (string,
    # see _vs_node). cable_speeds gets one entry per segment BOUNDARY
    # (not just cable edges -- crossing into/out of a virtual switch also
    # starts a new segment, just with no cable speed to show).
    segments = []
    cable_speeds = []
    for i, node in enumerate(port_path):
        if isinstance(node, str):
            vs_dev = devices[int(node.split(":", 1)[1])]
            dev_id, dev_name, dev_role = vs_dev["id"], vs_dev["name"], vs_dev["role"]
            entry = {"port_id": None,
                      "port_name": "wireless" if dev_role == "AP Group" else "virtual link",
                      "speed": None, "vlans": "", "poe_supply": False, "virtual": True}
        else:
            p = ports[node]
            dev_id, dev_name, dev_role = p["device_id"], p["device_name"], p["device_role"]
            entry = {"port_id": p["id"], "port_name": p["name"], "speed": p["speed"],
                      "vlans": p["vlans"], "poe_supply": bool(p["poe_supply"])}

        if segments and segments[-1]["device_id"] == dev_id:
            segments[-1]["ports"].append(entry)
        else:
            if segments:  # not the very first node -- record what crossed into this segment
                edge = edges_into[i]
                cable_speeds.append(edge[1] if edge and edge[0] == "cable" else None)
            segments.append({"device_id": dev_id, "device_name": dev_name, "device_role": dev_role,
                              "ports": [entry]})

    all_speeds = [ports[n]["speed"] for n in port_path if not isinstance(n, str) and ports[n]["speed"]]
    overall_speed = min(all_speeds, key=lambda s: crud.SPEED_MBPS.get(s, 0)) if all_speeds else None

    common = vlans_a & vlans_b
    if vlans_a and vlans_b:
        if common:
            vlan_note = {"status": "same", "detail": f"Shared VLAN(s): {', '.join(sorted(common))}"}
        else:
            vlan_note = {"status": "different",
                         "detail": f"{device_a['name']}: VLAN(s) {', '.join(sorted(vlans_a))} vs "
                                    f"{device_b['name']}: VLAN(s) {', '.join(sorted(vlans_b))}"}
    else:
        vlan_note = {"status": "unknown", "detail": "VLAN not tagged on one or both ends"}

    has_router = any(s["device_role"] == "Router/Firewall" for s in segments)

    return {
        "found": True,
        "device_a": device_a,
        "device_b": device_b,
        "segments": segments,
        "cable_speeds": cable_speeds,
        "overall_speed": overall_speed,
        "vlan_note": vlan_note,
        "routed_via_router": has_router,
    }
