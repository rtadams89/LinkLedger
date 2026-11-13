"""Finds the physical/logical path between two devices.

Graph model, rebuilt from the DB on every query:

- Every port is a node; a cable or pair link (patch panel front/rear, or
  any manually paired ports) is an edge.
- A Switch or Router/Firewall device bridges all of its own ports
  together.
- An AP Group / Virtual Switch device has no physical ports of its own;
  it gets one synthetic node, bridged to its uplinks and members.

VLANs are a search constraint, not a graph edge removal: if the two NICs
are on non-overlapping tagged VLANs, the path must pass through a
Router/Firewall device.

When a specific port isn't given, "start"/"end" is any port of that
device, and the search picks whichever port gives the shortest path.
"""

from collections import defaultdict, deque

from . import crud, db


def _vs_node(virtual_switch_id: int) -> str:
    """Synthetic node key for a virtual switch device (a string, unlike
    int port ids)."""
    return f"vs:{virtual_switch_id}"


def _build_graph(conn, forced_uplinks=None, exclude_vs_ids=None):
    """forced_uplinks: optional {virtual_switch_device_id: uplink_port_id},
    limiting that virtual switch to one uplink edge.

    exclude_vs_ids: optional set of virtual_switch_device_id values to omit
    entirely from the graph."""
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

    # AP Group / Virtual Switch devices: one synthetic node each, bridged
    # to their uplinks and their members.
    for dev_id, dev in devices.items():
        if dev.get("role") not in db.VIRTUAL_SWITCH_ROLES:
            continue
        if dev_id in exclude_vs_ids:
            continue
        node = _vs_node(dev_id)
        forced_port = forced_uplinks.get(dev_id)
        for u in crud.list_uplinks(conn, dev_id):
            pid = u["port_id"]
            if forced_port is not None and pid != forced_port:
                continue  # pinned to a different uplink
            adj[node].append((pid, "virtual-uplink", None))
            adj[pid].append((node, "virtual-uplink", None))
    for pid, p in ports.items():
        if p["virtual_switch_id"] and p["virtual_switch_id"] not in exclude_vs_ids:
            node = _vs_node(p["virtual_switch_id"])
            adj[node].append((pid, "virtual-link", None))
            adj[pid].append((node, "virtual-link", None))

    return ports, devices, by_device, adj


def _effective_vlan_set(conn, ports, port_ids):
    """A port's own VLAN tag takes priority; falls back to tracing outward
    for a port that doesn't carry one."""
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
    """Multi-source BFS. Returns (dist, prev) where dist[node] is the hop
    count from the nearest source, and prev[node] is
    (predecessor, edge_type, speed), or None for the sources themselves."""
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
    """port_a_id/port_b_id pin the search to a specific NIC; omitting
    either falls back to any port on that device.

    uplink_a_id/uplink_b_id pin the search to one uplink of a virtual
    switch the corresponding NIC is a member of. Raises ConflictError if
    the named NIC isn't such a member, or the uplink doesn't belong to
    that virtual switch.

    If uplink_a_id and uplink_b_id name two different uplinks of the same
    virtual switch, the search finds the backbone path between those two
    uplinks instead."""
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

    def _resolve_pin(label, chosen_port_id, uplink_id):
        """Returns (vs_id, uplink_port_id), or None if uplink_id wasn't
        given. Raises ConflictError if the chosen NIC isn't a
        virtual-switch member, or the uplink doesn't belong to that
        virtual switch."""
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

    # Both sides pinned to different uplinks of the same virtual switch.
    split = None
    forced_uplinks = {}
    if pin_a and pin_b and pin_a[0] == pin_b[0] and pin_a[1] != pin_b[1]:
        split = pin_a[0], pin_a[1], pin_b[1]
    else:
        for pin in (pin_a, pin_b):
            if pin:
                forced_uplinks[pin[0]] = pin[1]

    # VLANs across every candidate NIC on each side -- used only to decide
    # up front whether a router-free path could possibly work. Once a path
    # is actually found below, vlan_note is recomputed from the specific
    # ports it ends up using, not this candidate-wide union (a device with
    # several NICs on different VLANs could otherwise get a "same VLAN"
    # note that isn't true of the two ports the path actually picked).
    candidate_vlans_a = _effective_vlan_set(conn, ports, start_ports)
    candidate_vlans_b = _effective_vlan_set(conn, ports, end_ports)
    require_router = bool(candidate_vlans_a) and bool(candidate_vlans_b) and not (candidate_vlans_a & candidate_vlans_b)

    port_path = None
    combined_prev = None
    edges_into = None  # (edge_type, speed) aligned 1:1 with port_path; index 0 is always None

    if split:
        # Backbone search between the two uplinks, excluding the shared vs_node.
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
            # Find the router port minimizing (distance from start) + (distance from end).
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

    # Group consecutive same-device nodes into segments. cable_speeds gets
    # one entry per segment boundary.
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

    # port_path's first/last entries are always the concrete start/end ports
    # the search actually picked (never a virtual-switch node), so the VLAN
    # note reflects those two specific ports rather than every candidate NIC.
    vlans_a = _effective_vlan_set(conn, ports, [port_path[0]])
    vlans_b = _effective_vlan_set(conn, ports, [port_path[-1]])
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
