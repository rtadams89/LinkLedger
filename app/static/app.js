// ---------------------------------------------------------------------------
// Browser back/forward -- uses the History API to give the back/forward
// buttons a real place to go through LinkLedger's own view history. Every
// navigation (see navigateTo() below) pushes one history entry; popstate
// re-renders whatever view the browser lands back on. Each history entry
// also carries the scrollY the page was at when navigated away from, so
// back/forward restores scroll position.
// ---------------------------------------------------------------------------
// Leaves scroll restoration on popstate entirely to the code below instead
// of the browser's own guess.
if ("scrollRestoration" in history) history.scrollRestoration = "manual";

window.addEventListener("popstate", (e) => {
  renderView(e.state).then(() => {
    window.scrollTo(0, (e.state && e.state.scrollY) || 0);
  });
});

// ---------------------------------------------------------------------------
// API helper
// ---------------------------------------------------------------------------
async function api(path, options) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (res.status === 401 && path !== "/api/whoami") {
    // Reload so the bootstrap whoami check shows the login screen.
    location.reload();
    throw new Error("not signed in");
  }
  let body = null;
  try { body = await res.json(); } catch (e) { /* no body */ }
  if (!res.ok) {
    const msg = (body && body.detail) ? body.detail : `request failed (${res.status})`;
    throw new Error(msg);
  }
  return body;
}

// ---------------------------------------------------------------------------
// Auth / role
// ---------------------------------------------------------------------------
let CURRENT_ROLE = null;
let CURRENT_USERNAME = null;
function isAdmin() { return CURRENT_ROLE === "admin"; }

function showLoginScreen() {
  document.getElementById("mainApp").style.display = "none";
  document.getElementById("loginScreen").style.display = "flex";
  const u = document.getElementById("loginUser");
  if (u) u.focus();
}

function showMainApp() {
  document.getElementById("loginScreen").style.display = "none";
  document.getElementById("mainApp").style.display = "block";
}

async function submitLogin(event) {
  event.preventDefault();
  const username = document.getElementById("loginUser").value;
  const password = document.getElementById("loginPass").value;
  const errBox = document.getElementById("loginError");
  errBox.innerHTML = "";
  try {
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error((body && body.detail) || "sign-in failed");
    location.reload();
  } catch (e) {
    errBox.innerHTML = `<div class="error-msg">${esc(e.message)}</div>`;
  }
  return false;
}

async function logout() {
  try { await fetch("/api/logout", { method: "POST" }); } catch (e) { /* reloading regardless */ }
  location.reload();
}

function applyRoleVisibility() {
  // .admin-only defaults to display:none in the stylesheet. For admins we
  // strip the class so elements fall back to their normal display.
  document.querySelectorAll(".admin-only").forEach(el => {
    if (isAdmin()) el.classList.remove("admin-only");
    else el.style.display = "none";
  });
}

function showToast(msg, isError) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.style.background = isError ? "#dc2626" : "#0f172a";
  t.classList.add("show");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => t.classList.remove("show"), 2600);
}

// Roles whose ports can be tagged with VLAN(s) and "Supplies PoE". Kept
// in sync with db.VLAN_POE_CAPABLE_ROLES on the backend.
const VLAN_POE_CAPABLE_ROLES = ["Switch", "Router/Firewall"];

// Roles with no physical ports of their own. Kept in sync with
// db.VIRTUAL_SWITCH_ROLES on the backend.
const VIRTUAL_SWITCH_ROLES = ["AP Group", "Virtual Switch"];

const ROLE_COLORS = {
  "Switch": "#dcfce7", "Patch Panel": "#f1f5f9", "Router/Firewall": "#ffedd5",
  "Hypervisor": "#f3e8ff", "NAS": "#fef9c3", "Client": "#dbeafe", "Server": "#e0e7ff",
  "Access Point": "#dbeafe", "Appliance": "#dbeafe",
  "AP Group": "#cffafe", "Virtual Switch": "#e0f2fe", "Internet": "#f1f5f9",
};
const ROLE_TEXT = {
  "Switch": "#15803d", "Patch Panel": "#334155", "Router/Firewall": "#c2410c",
  "Hypervisor": "#6b21a8", "NAS": "#a16207", "Client": "#1e40af", "Server": "#4338ca",
  "Access Point": "#1e40af", "Appliance": "#1e40af",
  "AP Group": "#0e7490", "Virtual Switch": "#0369a1", "Internet": "#0f172a",
};
function roleBadge(role) {
  if (!role) return "";
  const bg = ROLE_COLORS[role] || "#e2e8f0";
  const fg = ROLE_TEXT[role] || "#334155";
  return `<span class="tag" style="background:${bg};color:${fg}">${esc(role)}</span>`;
}
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}

// Same as esc(), plus a <wbr> (word-break opportunity) after every "."
// and "-", so a long dotted hostname can wrap in a narrow result-list row.
function escBreakable(s) {
  return esc(s).replace(/([.-])/g, "$1<wbr>");
}

// ---------------------------------------------------------------------------
// Tabs / views
//
// Four views: "browse" (the device grid), "device" (one device's detail
// page), "path" (path finder), "reports".
//
// renderView() draws a view with no history/scroll side effects, so it's
// safe to call from popstate. Every user-initiated navigation goes through
// navigateTo() instead, which also stamps the outgoing view's scroll
// position and pushes a history entry. Refreshing the currently-open
// device in place after an edit is neither of those -- see
// refreshCurrentDevice().
// ---------------------------------------------------------------------------
let currentDeviceId = null;
let lastViewedDeviceId = null;

async function renderView(state) {
  const tab = (state && state.tab) || "browse";
  currentDeviceId = tab === "device" ? state.id : null;
  if (tab === "device" && state.id) lastViewedDeviceId = state.id;

  document.getElementById("tabBrowse").classList.toggle("active", tab === "browse");
  document.getElementById("tabDevice").classList.toggle("active", tab === "device");
  document.getElementById("tabPath").classList.toggle("active", tab === "path");
  document.getElementById("tabMap").classList.toggle("active", tab === "map");
  document.getElementById("tabReports").classList.toggle("active", tab === "reports");
  document.getElementById("tabDiscovery").classList.toggle("active", tab === "discovery");
  document.getElementById("browseView").style.display = tab === "browse" ? "block" : "none";
  document.getElementById("deviceView").style.display = tab === "device" ? "block" : "none";
  document.getElementById("pathView").style.display = tab === "path" ? "block" : "none";
  document.getElementById("mapView").style.display = tab === "map" ? "block" : "none";
  document.getElementById("reportsView").style.display = tab === "reports" ? "block" : "none";
  document.getElementById("discoveryView").style.display = tab === "discovery" ? "block" : "none";
  // Hidden until a device has been viewed at least once.
  document.getElementById("tabDevice").style.display = lastViewedDeviceId ? "" : "none";

  if (tab === "device" && state.id) await renderDeviceView(state.id, state.port);
  else if (tab === "path") await renderPathFinder();
  else if (tab === "map") await renderMapView();
  else if (tab === "reports") await renderReportsView();
  else if (tab === "discovery") await renderDiscoveryView();
  else await renderBrowseHome();
}

// Normalizes a portId argument (see deviceHref() below) -- a single id,
// an array of ids, or already a comma-joined string -- down to one
// comma-joined string ("" if there's nothing to highlight).
function portIdsParam(portId) {
  if (portId === undefined || portId === null || portId === "") return "";
  const ids = Array.isArray(portId) ? portId : [portId];
  return ids.filter(x => x !== null && x !== undefined).join(",");
}

// The address bar reflects the current device as ?device=<id>, plus
// ?port=<id>[,<id>] for state.port (one or more port ids, comma-joined,
// see portIdsParam() above) to scroll to and highlight on arrival.
function urlForState(state) {
  if (!(state && state.tab === "device" && state.id)) return location.pathname;
  return `${location.pathname}?device=${state.id}${state.port ? `&port=${state.port}` : ""}`;
}

// Reads ?device=<id>&port=<id>[,<id>...] off the URL the app was loaded
// with, so a bookmarked or shared link lands directly on that device.
function initialStateFromUrl() {
  const params = new URLSearchParams(location.search);
  const id = params.get("device");
  if (!(id && /^\d+$/.test(id))) return { tab: "browse" };
  const port = params.get("port");
  return { tab: "device", id: Number(id), port: port && /^\d+(,\d+)*$/.test(port) ? port : undefined };
}

// The href for a link to a device; pair with deviceLinkClick() on the
// same element. Pass portId (a single id, or an array -- see
// portIdsParam()) to scroll to and highlight specific port(s) on arrival.
function deviceHref(id, portId) {
  const p = portIdsParam(portId);
  return `${location.pathname}?device=${id}${p ? `&port=${p}` : ""}`;
}

// Click handler for every device link built from deviceHref() above.
// Lets a modified or right click fall through to the browser's normal
// handling; only intercepts a plain left-click for in-app navigation.
function deviceLinkClick(event, id, portId) {
  if (event.defaultPrevented || event.button !== 0 ||
      event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  viewDevice(id, portId);
}

async function navigateTo(state, opts) {
  opts = opts || {};
  if (!opts.replace && history.state) {
    // Stamp the scroll position onto the entry being left.
    history.replaceState({ ...history.state, scrollY: window.scrollY }, "", location.href);
  }
  await renderView(state);
  history[opts.replace ? "replaceState" : "pushState"]({ ...state, scrollY: 0 }, "", urlForState(state));
  // A highlighted port (state.port) already scrolls itself into view from
  // inside renderDeviceView().
  if (!(state.tab === "device" && state.port)) window.scrollTo(0, 0);
}

function showTab(which) {
  navigateTo({ tab: which });
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------
const searchInput = document.getElementById("search");
const resultsBox = document.getElementById("results");

searchInput.addEventListener("input", async () => {
  const q = searchInput.value.trim();
  if (!q) { resultsBox.classList.remove("show"); return; }
  const matches = await api(`/api/devices?q=${encodeURIComponent(q)}`);
  if (matches.length === 0) {
    resultsBox.innerHTML = `<div class="result-item">No matches</div>`;
  } else {
    resultsBox.innerHTML = matches.map(d =>
      `<a class="result-item" href="${deviceHref(d.id)}" onclick="deviceLinkClick(event, ${d.id})"><span>${escBreakable(d.name)}</span>${roleBadge(d.role)}</a>`
    ).join("");
  }
  resultsBox.classList.add("show");
});
// Closes any open autocomplete dropdown when clicking outside its wrapper.
document.addEventListener("click", (e) => {
  document.querySelectorAll(".autocomplete, .searchbar").forEach(wrap => {
    if (!wrap.contains(e.target)) {
      const box = wrap.querySelector(".results");
      if (box) box.classList.remove("show");
    }
  });
});

// ---------------------------------------------------------------------------
// Browse: device grid + device detail
// ---------------------------------------------------------------------------
let browseRoleFilter = "";

async function renderBrowseHome() {
  currentDeviceId = null;
  const devices = await api("/api/devices");
  const roleNames = [...new Set(devices.map(d => d.role).filter(Boolean))].sort();
  const filtered = browseRoleFilter ? devices.filter(d => d.role === browseRoleFilter) : devices;
  document.getElementById("browseView").innerHTML = `
    <div class="card">
      <div class="device-header">
        <strong>All devices</strong>
        <span class="note">${filtered.length}${filtered.length !== devices.length ? ` of ${devices.length}` : " total"}</span>
        <div class="spacer"></div>
        <select id="browseRoleFilter" style="width:auto;" onchange="onBrowseRoleFilterChange(this.value)">
          <option value="">All types</option>
          ${roleNames.map(r => `<option value="${esc(r)}" ${browseRoleFilter === r ? "selected" : ""}>${esc(r)}</option>`).join("")}
        </select>
      </div>
      <div class="device-grid">${filtered.map(deviceChip).join("")}</div>
      ${filtered.length === 0 ? `<div class="empty-state">No devices of this type.</div>` : ""}
    </div>`;
}

function onBrowseRoleFilterChange(value) {
  browseRoleFilter = value;
  renderBrowseHome();
}

function deviceChip(d) {
  return `<a class="device-chip" href="${deviceHref(d.id)}" onclick="deviceLinkClick(event, ${d.id})" title="${esc(d.name)}">
    <span class="chip-name">${esc(d.name)}</span><span class="role">${esc(d.role || "—")}</span>
  </a>`;
}

function cleanPortLabel(p) {
  return p.replace(" (rear)", "").replace(" (front)", "").replace(/^(\d+)$/, "port $1");
}

function speedTag(speed) {
  if (!speed) return "";
  return `<span class="tag speed-tag">${esc(speed)}</span>`;
}

function vlanTag(vlans) {
  if (!vlans) return "";
  return `<span class="tag vlan-tag">VLAN ${esc(vlans)}</span>`;
}

function poeSupplyTag(supplies) {
  if (!supplies) return "";
  return `<span class="tag poe-tag">&#9889; PoE</span>`;
}

function lagTag(lagName) {
  if (!lagName) return "";
  return `<span class="tag lag-tag">LAG: ${esc(lagName)}</span>`;
}

function macTag(mac) {
  if (!mac) return "";
  return `<span class="tag" style="background:#f1f5f9;color:#475569;font-family:monospace;">${esc(mac)}</span>`;
}

// Shown on a port that belongs to a device flagged as needing PoE --
// green if the far-end switch port actually supplies it, amber if not.
function poeNeedTag(deviceRequiresPoe, supplied) {
  if (!deviceRequiresPoe) return "";
  return supplied
    ? `<span class="tag poe-tag-ok">&#9889; PoE OK</span>`
    : `<span class="tag poe-tag-warn">&#9889; needs PoE, not supplied</span>`;
}

// Short plain-text summary of what a port's trace currently ends at --
// used in the Connect port modal's port pickers to label an in-use port.
function connectedToLabel(trace) {
  if (!trace || !trace.length) return "";
  const last = trace[trace.length - 1];
  return last.virtual ? last.device_name : `${last.device_name} (${cleanPortLabel(last.port_name)})`;
}

function chainHTML(trace, effectiveSpeed, effectiveVlans) {
  if (!trace || trace.length === 0) return `<span class="unused">not connected</span>`;
  const path = trace.map(h => {
    if (h.virtual) {
      const kind = h.device_role === "AP Group" ? "wireless" : "virtual link";
      const via = h.uplink_count === 0 ? ", no uplink configured yet"
        : h.uplink_count > 1 ? `, via any of ${h.uplink_count} uplinks` : "";
      return `<span class="arrow">&rarr;</span> <a class="link" href="${deviceHref(h.device_id)}" title="${esc(h.device_name)}" onclick="deviceLinkClick(event, ${h.device_id})">${esc(h.device_name)}</a> <span class="via">(${kind}${via})</span>`;
    }
    const label = cleanPortLabel(h.port_name);
    return `<span class="arrow">&rarr;</span> <a class="link" href="${deviceHref(h.device_id, h.port_id)}" title="${esc(h.device_name)}" onclick="deviceLinkClick(event, ${h.device_id}, ${h.port_id})">${esc(h.device_name)}</a> <span class="via">(${esc(label)})</span>`;
  }).join(" ");
  const extras = `${speedTag(effectiveSpeed)}${vlanTag(effectiveVlans)}`;
  return `${path}${extras ? " " + extras : ""}`;
}

function uplinkRows(d) {
  return `<table><tr><th>Uplink port</th><th></th></tr>${
    d.uplinks.length
      ? d.uplinks.map(u => `<tr>
          <td><a class="link" href="${deviceHref(u.device_id)}" onclick="deviceLinkClick(event, ${u.device_id})">${esc(u.device_name)}</a> <span class="via">(${esc(cleanPortLabel(u.port_name))})</span></td>
          <td>${isAdmin() ? `<button class="icon-btn" title="Remove uplink" onclick="removeUplink(${u.id}, ${d.id})">&#128465;</button>` : ""}</td>
        </tr>`).join("")
      : `<tr><td colspan="2"><span class="unused">no uplinks yet -- this ${esc(d.role)} can't reach the rest of the network</span></td></tr>`
  }</table>`;
}

function memberRows(d) {
  return `<table><tr><th>Member</th><th>VLAN</th></tr>${
    d.members.length
      ? d.members.map(m => `<tr>
          <td><a class="link" href="${deviceHref(m.device_id)}" onclick="deviceLinkClick(event, ${m.device_id})">${esc(m.device_name)}</a> <span class="via">(${esc(cleanPortLabel(m.port_name))})</span> ${roleBadge(m.device_role)}</td>
          <td>${vlanTag(m.vlans) || "—"}</td>
        </tr>`).join("")
      : `<tr><td colspan="2"><span class="unused">nothing joined yet -- link a device's port to this ${esc(d.role)} from that port's connect button</span></td></tr>`
  }</table>`;
}

function lagRows(d) {
  if (!d.lags || d.lags.length === 0) return "";
  return `
    <div class="device-header" style="margin-top:16px;"><strong>LAGs</strong>
      <span class="note">bonded groups of this device's own physical ports -- each member still has its own individual cable</span>
    </div>
    <table><tr><th>LAG</th><th>Member ports</th><th></th></tr>${
      d.lags.map(l => `<tr>
          <td class="port-name">${esc(l.name)}</td>
          <td>${l.members.length
            ? l.members.map(m => `${esc(cleanPortLabel(m.name))}${speedTag(m.speed)}`).join(", ")
            : `<span class="unused">no ports assigned yet</span>`}</td>
          <td>${isAdmin() ? `<button class="icon-btn" title="Delete LAG" onclick="deleteLag(${l.id}, ${d.id})">&#128465;</button>` : ""}</td>
        </tr>`).join("")
    }</table>`;
}

// Navigates to a device. Pushes a history entry and scrolls to top, or
// to the given port(s) if portId is passed (see portIdsParam() above).
async function viewDevice(id, portId) {
  searchInput.value = "";
  resultsBox.classList.remove("show");
  await navigateTo({ tab: "device", id, port: portIdsParam(portId) || undefined });
}

// Re-renders the currently-open device's page in place after an edit. Not
// a navigation, so no history entry and no scroll-to-top. A no-op if a
// device page isn't currently open.
async function refreshCurrentDevice() {
  if (currentDeviceId) await renderDeviceView(currentDeviceId);
}

async function renderDeviceView(id, highlightPortId) {
  let d;
  try {
    d = await api(`/api/devices/${id}`);
  } catch (e) {
    // Device no longer exists (e.g. via back/forward); show a way back.
    currentDeviceId = null;
    if (lastViewedDeviceId === id) lastViewedDeviceId = null;
    document.getElementById("tabDevice").style.display = lastViewedDeviceId ? "" : "none";
    document.getElementById("deviceView").innerHTML = `
      <div class="card"><div class="empty-state">
        This device no longer exists.<br>
        <button class="btn small" style="margin-top:10px;" onclick="navigateTo({tab:'browse'})">Back to Browse devices</button>
      </div></div>`;
    return;
  }
  currentDeviceId = id;
  lastViewedDeviceId = id;
  updateDeviceTabLabel(d.name);
  const isPanel = d.role === "Patch Panel";
  const isVirtualSwitch = VIRTUAL_SWITCH_ROLES.includes(d.role);

  let portRows, extraButtons;
  if (isVirtualSwitch) {
    portRows = `
      <div class="device-header" style="margin-top:16px;"><strong>Uplinks</strong>
        <span class="note">real ports elsewhere that this ${esc(d.role)} rides on top of</span>
        <div class="spacer"></div>
        <button class="btn small admin-only" onclick="openAddUplinkModal(${d.id})">+ Add uplink</button>
      </div>
      ${uplinkRows(d)}
      <div class="device-header" style="margin-top:16px;"><strong>Members</strong>
        <span class="note">ports elsewhere that join this ${esc(d.role)} instead of being cabled</span>
      </div>
      ${memberRows(d)}`;
    extraButtons = "";
  } else if (isPanel) {
    const rearMap = {}, frontMap = {};
    const strayPorts = [];
    d.ports.forEach(p => {
      const m = p.name.match(/^(\d+) \((rear|front)\)$/);
      if (m) (m[2] === "rear" ? rearMap : frontMap)[m[1]] = p;
      else strayPorts.push(p);
    });
    const nums = [...new Set([...Object.keys(rearMap), ...Object.keys(frontMap)])]
      .sort((a, b) => Number(a) - Number(b));
    portRows = nums.map(n => {
      const rear = rearMap[n], front = frontMap[n];
      return `<tr>
        <td class="port-name">Port ${n}</td>
        <td class="chain"${rear ? ` data-port-cell="${rear.id}"` : ""}>device side ${rear ? chainHTML(rear.trace, rear.effective_speed, rear.effective_vlans) + portActions(rear, d.role) : "—"}</td>
        <td class="chain"${front ? ` data-port-cell="${front.id}"` : ""}>switch side ${front ? chainHTML(front.trace, front.effective_speed, front.effective_vlans) + portActions(front, d.role) : "—"}</td>
      </tr>`;
    }).join("");
    portRows = `<table><tr><th>Port</th><th>Device side (rear)</th><th>Switch side (front)</th></tr>${portRows}</table>`;
    // Ports whose name doesn't match "N (front)"/"N (rear)" can't be
    // shown as a pair above; surface them here with edit/delete actions.
    if (strayPorts.length) {
      portRows += `
        <div class="device-header" style="margin-top:16px;"><strong>Other ports</strong>
          <span class="note">names that don't match this panel's "N (front)" / "N (rear)" pattern, so they can't show up as a pair above -- rename to fix, or delete and re-add with "+ Add paired ports"</span>
        </div>
        <table><tr><th>Name</th><th></th></tr>${strayPorts.map(p => `<tr>
          <td class="port-name">${esc(p.name)}</td>
          <td>${portActions(p, d.role)}</td>
        </tr>`).join("")}</table>`;
    }
    // No generic "+ Add port(s)" button here; "+ Add paired ports" is the
    // only flow that produces a correctly named, paired port.
    { const nextStart = nums.length ? Math.max(...nums.map(Number)) + 1 : 1;
    extraButtons = `<button class="btn small admin-only" onclick="openPatchPanelModal(${d.id}, ${nextStart})">+ Add paired ports</button>`; }
  } else {
    portRows = `<table><tr><th>Port / NIC</th><th>Connected to</th><th></th></tr>` +
      d.ports.map(p => `<tr data-port-row="${p.id}">
        <td class="port-name">${esc(p.name)} ${speedTag(p.speed)}${VLAN_POE_CAPABLE_ROLES.includes(d.role) ? poeSupplyTag(p.poe_supply) + vlanTag(p.vlans) : (p.virtual_switch_id ? vlanTag(p.vlans) : "")}${lagTag(p.lag_name)}${macTag(p.mac_address)}</td>
        <td class="chain">${chainHTML(p.trace, p.effective_speed, p.effective_vlans)} ${poeNeedTag(d.poe_required, p.poe_supplied)}</td>
        <td>${portActions(p, d.role)}</td>
      </tr>`).join("") + `</table>`;
    portRows += lagRows(d);
    extraButtons = `<button class="btn small admin-only" onclick="openPortModal(${d.id}, '${d.role}')">+ Add port(s)</button>` +
      (d.ports.length >= 2 ? `<button class="btn small admin-only" onclick='openAddLagModal(${d.id}, ${JSON.stringify(d.ports.map(p => ({ id: p.id, name: p.name }))).replace(/'/g, "&#39;")})'>+ Add LAG</button>` : "");
  }

  document.getElementById("deviceView").innerHTML = `
    <div class="print-meta">LinkLedger &mdash; printed ${esc(new Date().toLocaleString())}</div>
    <div class="card">
      <div class="device-header">
        <h2>${esc(d.name)}</h2>
        ${roleBadge(d.role)}
        ${d.poe_required ? `<span class="tag poe-tag">&#9889; needs PoE</span>` : ""}
        ${d.model ? `<span class="note">${esc(d.model)}</span>` : ""}
        ${d.site ? `<span class="note">· ${esc(d.site)}</span>` : ""}
        <div class="spacer"></div>
        <button class="btn small" onclick="window.print()">Print</button>
        ${d.ports && d.ports.length && !isVirtualSwitch ? `<button class="btn small admin-only" onclick="openPortLayoutModal(${d.id})">Edit port layout</button>` : ""}
        <button class="btn small admin-only" onclick="openDeviceModal(${d.id})">Edit</button>
        <button class="btn small danger admin-only" onclick='confirmDeleteDevice(${d.id}, ${JSON.stringify(d.name).replace(/'/g, "&#39;")})'>Delete</button>
      </div>
      ${d.notes ? `<p class="note">${esc(d.notes)}</p>` : ""}
      ${portRows}
      ${extraButtons ? `<div style="margin-top:12px; display:flex; gap:8px;" class="print-hide">${extraButtons}</div>` : ""}
    </div>`;
  applyRoleVisibility();
  if (highlightPortId) highlightPorts(highlightPortId);
}

// Scrolls to and briefly highlights one or more specific ports (accepts
// the single-id/array/comma-string forms from portIdsParam() above). A
// regular device's ports table tags each whole <tr> with data-port-row; a
// patch panel's table tags each <td> in a pair's row with data-port-cell,
// since "device side" and "switch side" can be different connections.
function highlightPorts(portIds) {
  const ids = (Array.isArray(portIds) ? portIds : String(portIds).split(","))
    .map(x => String(x).trim()).filter(Boolean);
  let scrolled = false;
  ids.forEach(portId => {
    const row = document.querySelector(`[data-port-row="${portId}"]`);
    const target = row || document.querySelector(`[data-port-cell="${portId}"]`);
    if (!target) return;
    (row ? [...row.children] : [target]).forEach(el => el.classList.add("port-highlight"));
    if (!scrolled) { target.scrollIntoView({ block: "center" }); scrolled = true; }
  });
}

function updateDeviceTabLabel(name) {
  const btn = document.getElementById("tabDevice");
  btn.textContent = name;
  btn.title = name;
}

function portActions(p, deviceRole) {
  if (!isAdmin()) return "";
  const connected = p.trace && p.trace.length > 0;
  let disconnectBtn;
  if (p.virtual_switch_id) {
    disconnectBtn = `<button class="icon-btn" title="Unlink" onclick="unlinkVirtual(${p.id})">&#10005;</button>`;
  } else if (connected) {
    disconnectBtn = `<button class="icon-btn" title="Disconnect" onclick="disconnectPort(${p.id})">&#10005;</button>`;
  } else {
    disconnectBtn = `<button class="icon-btn" title="Connect" onclick="openConnectModal(${p.id})">&#128279;</button>`;
  }
  const portData = {
    id: p.id, name: p.name, speed: p.speed, vlans: p.vlans, poe_supply: p.poe_supply,
    mac_address: p.mac_address, deviceRole, virtual_switch_id: p.virtual_switch_id,
  };
  return `<span class="row-actions">
    ${disconnectBtn}
    <button class="icon-btn" title="Edit port" onclick='openEditPortModal(${JSON.stringify(portData).replace(/'/g, "&#39;")})'>&#9998;</button>
    <button class="icon-btn" title="Delete port" onclick="deletePort(${p.id})">&#128465;</button>
  </span>`;
}

async function unlinkVirtual(portId) {
  try {
    await api(`/api/ports/${portId}/virtual-link`, { method: "POST", body: JSON.stringify({ virtual_switch_id: null }) });
    showToast("Unlinked");
    refreshCurrentDevice();
  } catch (e) { showToast(e.message, true); }
}

// ---------------------------------------------------------------------------
// Path finder
// ---------------------------------------------------------------------------
function pathDeviceField(which, label) {
  return `
    <div class="field autocomplete" style="flex:1; min-width:180px; margin-bottom:0;">
      <label>${label}</label>
      <input type="text" id="pf_${which}Search" placeholder="Search a device..." autocomplete="off" oninput="onPathDeviceSearch('${which}')">
      <input type="hidden" id="pf_${which}">
      <div class="results wide" id="pf_${which}Results"></div>
    </div>`;
}

async function renderPathFinder(selA, selB) {
  document.getElementById("pathView").innerHTML = `
    <div class="card">
      <div style="display:flex; gap:10px; align-items:end; flex-wrap:wrap;">
        ${pathDeviceField("a", "Device A")}
        <div class="field" style="flex:1; min-width:160px; margin-bottom:0;"><label>NIC on A</label>
          <select id="pf_portA" onchange="onPathPortChange('a')"><option value="">Select device first...</option></select>
        </div>
        <div id="pf_aViaWrap"></div>
        ${pathDeviceField("b", "Device B")}
        <div class="field" style="flex:1; min-width:160px; margin-bottom:0;"><label>NIC on B</label>
          <select id="pf_portB" onchange="onPathPortChange('b')"><option value="">Select device first...</option></select>
        </div>
        <div id="pf_bViaWrap"></div>
        <button class="btn primary" onclick="submitFindPath()">Find path</button>
      </div>
    </div>
    <div id="pathResult"></div>`;
  PF_PORTS = { a: [], b: [] };
  if (selA) await selectPathDeviceById("a", selA);
  if (selB) await selectPathDeviceById("b", selB);
}

// Last-fetched device's ports for each side, so onPathPortChange can look
// up the chosen NIC's virtual_switch_id without a round-trip.
let PF_PORTS = { a: [], b: [] };

async function onPathDeviceSearch(which) {
  const q = document.getElementById(`pf_${which}Search`).value.trim();
  const box = document.getElementById(`pf_${which}Results`);
  if (!q) { box.classList.remove("show"); return; }
  const matches = await api(`/api/devices?q=${encodeURIComponent(q)}`);
  box.innerHTML = matches.length
    ? matches.map(d => `<div class="result-item" onclick='selectPathDevice("${which}", ${d.id}, ${JSON.stringify(d.name).replace(/'/g, "&#39;")})'><span>${escBreakable(d.name)}</span>${roleBadge(d.role)}</div>`).join("")
    : `<div class="result-item">No matches</div>`;
  box.classList.add("show");
}

function selectPathDevice(which, id, name) {
  document.getElementById(`pf_${which}`).value = id;
  const inp = document.getElementById(`pf_${which}Search`);
  inp.value = name;
  inp.title = name;
  document.getElementById(`pf_${which}Results`).classList.remove("show");
  onPathDeviceChange(which);
}

async function selectPathDeviceById(which, deviceId) {
  const d = await api(`/api/devices/${deviceId}`);
  selectPathDevice(which, deviceId, d.name);
}

async function onPathDeviceChange(which) {
  const deviceId = document.getElementById(`pf_${which}`).value;
  const sel = document.getElementById(`pf_port${which.toUpperCase()}`);
  clearPathVia(which);
  PF_PORTS[which] = [];
  if (!deviceId) { sel.innerHTML = `<option value="">Select device first...</option>`; return; }
  const d = await api(`/api/devices/${deviceId}`);
  PF_PORTS[which] = d.ports;
  if (d.ports.length === 0) {
    sel.innerHTML = `<option value="">(no ports on this device)</option>`;
    return;
  }
  // Devices with more than one port require an explicit pick.
  const placeholder = d.ports.length > 1 ? `<option value="">Select a NIC...</option>` : "";
  sel.innerHTML = placeholder + d.ports.map(p => `<option value="${p.id}">${esc(cleanPortLabel(p.name))}</option>`).join("");
  // A single-port device auto-fills the NIC; still run the virtual-link check.
  if (d.ports.length === 1) onPathPortChange(which);
}

function clearPathVia(which) {
  document.getElementById(`pf_${which}ViaWrap`).innerHTML = "";
}

// If the chosen NIC is a virtual link member of an AP Group / Virtual
// Switch, offers a way to pin the search to one specific uplink. A no-op
// for a normal wired NIC. If there's only one uplink on record, it's
// still shown, disabled and pre-filled.
async function onPathPortChange(which) {
  clearPathVia(which);
  const sel = document.getElementById(`pf_port${which.toUpperCase()}`);
  const portId = Number(sel.value);
  const port = (PF_PORTS[which] || []).find(p => p.id === portId);
  if (!port || !port.virtual_switch_id) return;
  const vs = await api(`/api/devices/${port.virtual_switch_id}`);
  if (!vs.uplinks || vs.uplinks.length === 0) return;
  const label = vs.role === "AP Group" ? "Via AP" : "Via uplink";
  const uplinkLabel = u => `${esc(u.device_name)} &mdash; ${esc(cleanPortLabel(u.port_name))}`;
  const single = vs.uplinks.length === 1;
  const options = single
    ? `<option value="${vs.uplinks[0].port_id}" selected>${uplinkLabel(vs.uplinks[0])}</option>`
    : [`<option value="">Best route (auto)</option>`].concat(vs.uplinks.map(u => `<option value="${u.port_id}">${uplinkLabel(u)}</option>`)).join("");
  const hint = single
    ? `<span class="note">(only one on record for ${esc(vs.name)})</span>`
    : `<span class="note">(optional)</span>`;
  document.getElementById(`pf_${which}ViaWrap`).innerHTML = `
    <div class="field" style="flex:1; min-width:200px; margin-bottom:0;">
      <label>${label} ${hint}</label>
      <select id="pf_${which}Via" ${single ? "disabled" : ""}>${options}</select>
    </div>`;
}

function pathSegmentHTML(seg, isFirst, isLast) {
  // Patch panels enter/exit on the (rear)/(front) suffix of the same
  // number, so that suffix is kept rather than stripped like elsewhere.
  const isPanel = seg.device_role === "Patch Panel";
  const portLabels = seg.ports.map(p => isPanel ? p.port_name : cleanPortLabel(p.port_name));
  const portDisplay = portLabels.length > 1
    ? `${esc(portLabels[0])} &rarr; ${esc(portLabels[portLabels.length - 1])}`
    : esc(portLabels[0]);
  const poeBits = seg.ports.filter(p => p.poe_supply).length
    ? poeSupplyTag(true)
    : "";
  // A regular hop's segment has one real port; a patch-panel pass-through
  // segment has two (rear and front); a virtual-switch hop has none
  // (port_id is null). See highlightPorts().
  const portIds = seg.ports.map(p => p.port_id).filter(id => id !== null && id !== undefined);
  return `<div class="path-hop">
    <div class="path-hop-device"><a class="link" href="${deviceHref(seg.device_id, portIds)}" title="${esc(seg.device_name)}" onclick="deviceLinkClick(event, ${seg.device_id}, [${portIds.join(",")}])">${esc(seg.device_name)}</a> ${roleBadge(seg.device_role)}</div>
    <div class="path-hop-port">${portDisplay} ${poeBits}</div>
  </div>`;
}

async function submitFindPath() {
  const a = document.getElementById("pf_a").value;
  const b = document.getElementById("pf_b").value;
  const portA = document.getElementById("pf_portA").value;
  const portB = document.getElementById("pf_portB").value;
  const viaAEl = document.getElementById("pf_aVia");
  const viaBEl = document.getElementById("pf_bVia");
  const viaA = viaAEl ? viaAEl.value : "";
  const viaB = viaBEl ? viaBEl.value : "";
  const resultBox = document.getElementById("pathResult");
  if (!a || !b) {
    resultBox.innerHTML = `<div class="card"><div class="error-msg">Pick two devices.</div></div>`;
    return;
  }
  if (!portA || !portB) {
    resultBox.innerHTML = `<div class="card"><div class="error-msg">Pick a source and destination NIC -- a device can have more than one, and which one you start/end from can change the path.</div></div>`;
    return;
  }
  resultBox.innerHTML = `<div class="card"><span class="note">Searching...</span></div>`;
  try {
    let url = `/api/path?a=${a}&b=${b}&port_a=${portA}&port_b=${portB}`;
    if (viaA) url += `&uplink_a=${viaA}`;
    if (viaB) url += `&uplink_b=${viaB}`;
    const p = await api(url);
    if (!p.found) {
      resultBox.innerHTML = `<div class="card"><div class="empty-state">${esc(p.reason || "No path found.")}</div></div>`;
      return;
    }
    const hops = p.segments.map((seg, i) => {
      const html = pathSegmentHTML(seg, i === 0, i === p.segments.length - 1);
      if (i === 0) return html;
      const speed = p.cable_speeds[i - 1];
      return `<div class="path-arrow">&darr; ${speedTag(speed)}</div>${html}`;
    }).join("");

    const vlanClass = p.vlan_note.status === "same" ? "vlan-note-same"
      : p.vlan_note.status === "different" ? "vlan-note-diff" : "vlan-note-unknown";

    LAST_PATH_RESULT = p;
    resultBox.innerHTML = `
      <div class="card">
        <div class="path-summary">
          ${speedTag(p.overall_speed) || `<span class="note">Speed not tagged along this path</span>`}
          ${p.routed_via_router ? `<span class="tag" style="background:#ffedd5;color:#c2410c;">Routes through a Router/Firewall</span>` : `<span class="tag" style="background:#dcfce7;color:#15803d;">Direct switch path -- no router hop</span>`}
          <button class="btn small" onclick="showPathOnMap()">Show on map</button>
        </div>
        <div class="vlan-note ${vlanClass}">${esc(p.vlan_note.detail)}</div>
        <div class="path-chain">${hops}</div>
      </div>`;
  } catch (e) {
    resultBox.innerHTML = `<div class="card"><div class="error-msg">${esc(e.message)}</div></div>`;
  }
}

// Last successful /api/path result, kept so "Show on map" can re-derive a
// highlight without re-querying.
let LAST_PATH_RESULT = null;

// ---------------------------------------------------------------------------
// Map -- a to-scale graphical layout of every device and cable, drawn as
// plain SVG. By default each device's ports wrap into a single row
// (mapAutoGridLayout); "Edit port layout" on the device page switches a
// device to a free-form per-port grid instead (mapCustomGridLayout), so
// e.g. a patch panel split across two rows of 12 can look like one on the
// map. A patch panel's front/rear pair renders as a single jack either
// way, since that's the same physical point with a cable on each side;
// everything else gets one jack per port. LAG members and multiple
// patch-panel runs each keep their own line (offset slightly apart)
// since they're really separate cables.
// ---------------------------------------------------------------------------
const MAP_JACK = 22;
const MAP_JACK_R = 5;
const MAP_PAD = 10;
const MAP_HEADER = 22;

let MAP_DATA = null;
let MAP_PORT_BY_ID = {};
let MAP_CABLED_PORTS = new Set();
let MAP_NODE_ORIGIN = {};  // device_id -> {x,y}, top-left, mutable (dragging)
let MAP_NODE_BOX = {};     // device_id -> {width, height, cols, rows, positions:[{ports,x,y}]}
let MAP_PORT_JACK = {};    // port_id -> {devId, x, y} (local to the owning node)
let MAP_VIEW = { scale: 1, tx: 40, ty: 40 };
let MAP_HIGHLIGHT = null;  // {deviceIds:Set, jackKeys:Set(port_id), cableIds:Set} or null
let PENDING_MAP_HIGHLIGHT = null;
let MAP_DRAG = null;
let MAP_PAN = null;
let MAP_SUPPRESS_CLICK = false;
// The cable/vlink group currently under the pointer, or null. Letting a
// specific cable be traced by just hovering it (see mapSetHoverEdge)
// matters most on a busy diagram -- e.g. a dense run of patch-panel-to-
// switch cables where several routes pass close enough together that
// it's hard to tell by eye alone where any one of them starts and ends.
let MAP_HOVER_EL = null;

function mapIndexPorts(data) {
  const idx = {};
  data.devices.forEach(d => (d.ports || []).forEach(p => { idx[p.id] = { ...p, device_id: d.id, device_name: d.name }; }));
  return idx;
}

function mapCabledPortIds(data) {
  const s = new Set();
  data.cables.forEach(c => { s.add(c.a_port_id); s.add(c.b_port_id); });
  return s;
}

// Groups a patch panel's ports into front/rear pairs (one jack each);
// every other device just gets one position per port. Ordered by id, same
// as the device's own port list.
function mapDevicePositions(dev) {
  const ports = dev.ports || [];
  if (dev.role === "Patch Panel") {
    const byId = new Map(ports.map(p => [p.id, p]));
    const seen = new Set();
    const groups = [];
    ports.forEach(p => {
      if (seen.has(p.id)) return;
      const other = p.pair_port_id ? byId.get(p.pair_port_id) : null;
      if (other) { seen.add(p.id); seen.add(other.id); groups.push({ key: Math.min(p.id, other.id), ports: [p, other] }); }
      else { seen.add(p.id); groups.push({ key: p.id, ports: [p] }); }
    });
    groups.sort((a, b) => a.key - b.key);
    return groups;
  }
  return ports.map(p => ({ key: p.id, ports: [p] }));
}

// Shared by the Map tab's custom-mode rendering and the port-layout
// editor (see openPortLayoutModal): reads each position's own stored
// grid_row/grid_col when the WHOLE group (both ports of a patch-panel
// pair) has one, and falls back to a deterministic slot -- appended in a
// new row below whatever's already placed -- for a group that doesn't
// (e.g. a port added to a device that's already in custom mode, before
// ever being dragged anywhere). `fallbackCols` only bounds how those
// fallback slots wrap; it has no effect once every group has a real
// position. Returns {positions:[...{...group, row, col}], cols, rows}.
function mapCustomGridLayout(positions, fallbackCols) {
  const known = [], unknown = [];
  positions.forEach(pos => {
    const p0 = pos.ports[0];
    if (p0.grid_row != null && p0.grid_col != null) known.push({ ...pos, row: p0.grid_row, col: p0.grid_col });
    else unknown.push(pos);
  });
  let row = known.reduce((m, p) => Math.max(m, p.row), -1) + 1, col = 0;
  unknown.forEach(pos => {
    known.push({ ...pos, row, col });
    col++;
    if (col >= fallbackCols) { col = 0; row++; }
  });
  known.sort((a, b) => a.key - b.key);
  const cols = known.length ? Math.max(...known.map(p => p.col)) + 1 : 0;
  const rows = known.length ? Math.max(...known.map(p => p.row)) + 1 : 0;
  return { positions: known, cols, rows };
}

// The current ports_per_row-wrap layout, expressed the same shape as
// mapCustomGridLayout's return value -- used both as mapNodeBox's normal
// ('auto' mode) path and as the port-layout editor's starting point when
// a device hasn't been switched to a custom layout yet (see
// openPortLayoutModal), so the editor opens from something familiar
// instead of a blank grid.
function mapAutoGridLayout(positions, portsPerRow) {
  // wrapCols is how many positions fit before wrapping to the next row;
  // cols is how many are actually ever occupied (e.g. 3 ports with
  // ports_per_row=10 only ever use 3 columns, not 10) -- the box should
  // size to the latter, not the configured wrap width.
  const wrapCols = (portsPerRow && portsPerRow > 0) ? portsPerRow : (positions.length || 1);
  const withCoords = positions.map((pos, i) => ({ ...pos, row: Math.floor(i / wrapCols), col: i % wrapCols }));
  const rows = positions.length ? Math.ceil(positions.length / wrapCols) : 0;
  const cols = positions.length ? Math.min(positions.length, wrapCols) : 0;
  return { positions: withCoords, cols, rows };
}

function mapNodeBox(dev) {
  const groups = mapDevicePositions(dev);
  const { positions, cols, rows } = dev.port_layout_mode === "custom"
    ? mapCustomGridLayout(groups, 12)
    : mapAutoGridLayout(groups, dev.ports_per_row);
  const gridW = cols * MAP_JACK;
  const labelW = Math.max(100, dev.name.length * 6.5 + 24);
  const width = Math.max(labelW, gridW + MAP_PAD * 2);
  const height = MAP_HEADER + (rows ? rows * MAP_JACK + MAP_PAD : 14);
  return { positions, cols, rows, width, height };
}

// Grid fallback, grouped by site, for any device with no saved position
// yet -- just a starting point until it's dragged into its real spot.
// Walks each candidate grid slot forward until it finds one that doesn't
// overlap a box that's already spoken for -- either a device the user
// has deliberately dragged somewhere (pos_x/pos_y set), or an
// already-auto-placed device from earlier in this same pass. Without
// this, a plain sequential grid can land a brand-new, never-positioned
// device's box directly on top of one the user placed on purpose
// (coincidence, but a near-guarantee in a big imported dataset where
// most devices haven't been dragged into place yet); the router then
// can't find any path in or out of whichever device lost the ownership
// tie for the shared cells, and the cable for it falls back to a raw
// straight line that cuts through the whole diagram ignoring every
// other box in its way.
function mapAutoPlace(devices) {
  const PAD = 24;
  const boxOf = {};
  devices.forEach(d => { boxOf[d.id] = mapNodeBox(d); });

  const occupied = [];
  const overlapsOccupied = (cx, cy, width, height) => {
    const x0 = cx - width / 2 - PAD, y0 = cy - height / 2 - PAD;
    const x1 = cx + width / 2 + PAD, y1 = cy + height / 2 + PAD;
    return occupied.some(o => !(x1 <= o.x0 || o.x1 <= x0 || y1 <= o.y0 || o.y1 <= y0));
  };
  const occupy = (cx, cy, width, height) => {
    occupied.push({ x0: cx - width / 2 - PAD, y0: cy - height / 2 - PAD, x1: cx + width / 2 + PAD, y1: cy + height / 2 + PAD });
  };

  devices.forEach(d => {
    if (d.pos_x != null && d.pos_y != null) {
      const { width, height } = boxOf[d.id];
      occupy(d.pos_x, d.pos_y, width, height);
    }
  });

  const bySite = {};
  devices.forEach(d => {
    if (d.pos_x == null || d.pos_y == null) (bySite[d.site || "(no site)"] ||= []).push(d);
  });
  const placed = {};
  let siteRow = 0;
  Object.keys(bySite).sort().forEach(site => {
    const list = bySite[site].slice().sort((a, b) => a.name.localeCompare(b.name));
    const perRow = 6;
    let slot = 0;
    list.forEach(d => {
      const { width, height } = boxOf[d.id];
      let cx, cy, guard = 0;
      do {
        cx = 140 + (slot % perRow) * 220;
        cy = siteRow * 260 + 90 + Math.floor(slot / perRow) * 170;
        slot++;
      } while (overlapsOccupied(cx, cy, width, height) && ++guard < 10000);
      placed[d.id] = { x: cx, y: cy };
      occupy(cx, cy, width, height);
    });
    siteRow++;
  });
  return placed;
}

function mapBuildLayout(devices) {
  MAP_NODE_ORIGIN = {}; MAP_NODE_BOX = {}; MAP_PORT_JACK = {};
  const auto = mapAutoPlace(devices);
  devices.forEach(dev => {
    const { positions, cols, rows, width, height } = mapNodeBox(dev);
    const center = (dev.pos_x != null && dev.pos_y != null) ? { x: dev.pos_x, y: dev.pos_y } : auto[dev.id];
    MAP_NODE_ORIGIN[dev.id] = { x: center.x - width / 2, y: center.y - height / 2 };
    // Every position already carries its own row/col from mapNodeBox
    // (sequential ports_per_row wrap in 'auto' mode, the device's own
    // stored grid in 'custom' mode) -- just place it.
    const gridW = cols * MAP_JACK;
    const startX = (width - gridW) / 2 + MAP_JACK / 2;
    const localPositions = positions.map(pos => {
      const lx = startX + pos.col * MAP_JACK;
      const ly = MAP_HEADER + MAP_PAD / 2 + pos.row * MAP_JACK + MAP_JACK / 2;
      pos.ports.forEach(p => { MAP_PORT_JACK[p.id] = { devId: dev.id, x: lx, y: ly }; });
      return { ...pos, x: lx, y: ly };
    });
    MAP_NODE_BOX[dev.id] = { width, height, cols, rows, positions: localPositions };
  });
}

function mapJackAbs(portId) {
  const j = MAP_PORT_JACK[portId];
  if (!j) return null;
  const o = MAP_NODE_ORIGIN[j.devId];
  return o ? { x: o.x + j.x, y: o.y + j.y } : null;
}
function mapAnchorAbs(devId) {
  const box = MAP_NODE_BOX[devId], o = MAP_NODE_ORIGIN[devId];
  return (box && o) ? { x: o.x + box.width / 2, y: o.y + box.height / 2 } : null;
}

function mapPositionStatus(pos, cabled) {
  const linked = pos.ports.map(p => cabled.has(p.id) || !!p.virtual_switch_id);
  if (linked.every(Boolean)) return "full";
  if (linked.some(Boolean)) return "partial";
  return "empty";
}

// Node rendering is split into two layers -- the box (rect+label) and
// the jacks -- drawn on either side of the cable edges in drawMap(), so
// a cable is visible crossing into its own endpoint device's box up to
// the jack, instead of being hidden behind that device's opaque
// rectangle (which used to make every cable look like it stopped at the
// device's edge rather than reaching the specific port).
function mapNodeBoxSVG(dev) {
  const box = MAP_NODE_BOX[dev.id];
  const origin = MAP_NODE_ORIGIN[dev.id];
  const bg = ROLE_COLORS[dev.role] || "#e2e8f0";
  const fg = ROLE_TEXT[dev.role] || "#334155";
  const hl = MAP_HIGHLIGHT;
  const nodeHL = !!(hl && hl.deviceIds.has(dev.id));
  // A normally-hidden device only ever reaches this function when it's
  // pulled onto the map by a highlighted path (see mapFilteredDevices) --
  // styled as a dashed/dimmed box so it still reads as "normally hidden".
  const isHidden = !dev.show_on_map;
  const draggable = isAdmin() ? " map-node-draggable" : "";
  return `<g class="map-node${draggable}${nodeHL ? " map-node-hl" : ""}${isHidden ? " map-node-hidden" : ""}" id="mapNode-${dev.id}" data-device-id="${dev.id}" transform="translate(${origin.x},${origin.y})">
    <rect class="map-node-rect" x="0" y="0" width="${box.width}" height="${box.height}" rx="8" fill="${bg}" stroke="${nodeHL ? "#2563eb" : fg}" stroke-width="${nodeHL ? 2.5 : 1.3}" stroke-dasharray="${isHidden ? "4 2" : "none"}"></rect>
    <text class="map-node-label" x="${box.width / 2}" y="15" text-anchor="middle" font-size="11" font-weight="700" fill="${fg}">${esc(dev.name)}${isHidden ? " (hidden)" : ""}</text>
  </g>`;
}

function mapNodeJacksSVG(dev) {
  const box = MAP_NODE_BOX[dev.id];
  const origin = MAP_NODE_ORIGIN[dev.id];
  const hl = MAP_HIGHLIGHT;
  const jacks = box.positions.map(pos => {
    const status = mapPositionStatus(pos, MAP_CABLED_PORTS);
    const fill = status === "full" ? "#22c55e" : status === "partial" ? "#f59e0b" : "#cbd5e1";
    const ids = pos.ports.map(p => p.id).join(",");
    const isHL = !!(hl && pos.ports.some(p => hl.jackKeys.has(p.id)));
    return `<circle class="map-jack${isHL ? " map-jack-hl" : ""}" data-dev="${dev.id}" data-ports="${ids}" cx="${pos.x}" cy="${pos.y}" r="${MAP_JACK_R}" fill="${fill}" stroke="${isHL ? "#2563eb" : "#fff"}" stroke-width="${isHL ? 2.5 : 1}"><title>${esc(pos.ports.map(p => p.name).join(" / "))}</title></circle>`;
  }).join("");
  return `<g class="map-node-jacks" id="mapNodeJacks-${dev.id}" data-device-id="${dev.id}" transform="translate(${origin.x},${origin.y})">${jacks}</g>`;
}

// ---------------------------------------------------------------------------
// Cable routing -- orthogonal (45/90-degree-turn only) paths between the
// two exact jacks, instead of a straight line cutting through whatever's
// in between. This is an 8-directional A* over a coarse grid: every
// device's box (plus a little clearance) is an obstacle, a cable's own
// two endpoint devices are exempt from blocking its own route (so it can
// actually leave/reach its jack), and a shared "congestion" counter nudges
// later cables a lane or two away from corridors earlier ones already
// used, so parallel runs spread out instead of stacking on top of each
// other -- including LAG members and multiple patch-panel runs between
// the same pair of devices, which used to get a fixed perpendicular
// offset; the router now handles that spacing the same way it does for
// any other pair of nearby cables.
// ---------------------------------------------------------------------------
const MAP_ROUTE_CELL = 14;
const MAP_ROUTE_TURN_PENALTY = 0.75;
const MAP_ROUTE_CONGESTION_WEIGHT = 0.9;
const MAP_ROUTE_DIRS = [
  [0, 1, 1], [0, -1, 1], [1, 0, 1], [-1, 0, 1],
  [1, 1, Math.SQRT2], [-1, -1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2],
];

class MapMinHeap {
  constructor() { this.a = []; }
  push(idx, pri) {
    const a = this.a; a.push([pri, idx]);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      [a[p], a[i]] = [a[i], a[p]]; i = p;
    }
  }
  pop() {
    const a = this.a;
    if (!a.length) return undefined;
    const top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (; ;) {
        const l = i * 2 + 1, r = i * 2 + 2;
        let s = i;
        if (l < a.length && a[l][0] < a[s][0]) s = l;
        if (r < a.length && a[r][0] < a[s][0]) s = r;
        if (s === i) break;
        [a[s], a[i]] = [a[i], a[s]]; i = s;
      }
    }
    return top[1];
  }
  get size() { return this.a.length; }
}

// Builds the shared obstacle/usage grid for one full map draw. `owner`
// records which device each blocked cell belongs to, so a cable routing
// from/to that device can still step through its own footprint.
function mapBuildRouteGrid(devices) {
  const bounds = mapBoundsFor(devices.map(d => d.id)) || { minX: 0, minY: 0, maxX: 800, maxY: 600 };
  const margin = 100;
  const originX = Math.floor((bounds.minX - margin) / MAP_ROUTE_CELL) * MAP_ROUTE_CELL;
  const originY = Math.floor((bounds.minY - margin) / MAP_ROUTE_CELL) * MAP_ROUTE_CELL;
  const endX = Math.ceil((bounds.maxX + margin) / MAP_ROUTE_CELL) * MAP_ROUTE_CELL;
  const endY = Math.ceil((bounds.maxY + margin) / MAP_ROUTE_CELL) * MAP_ROUTE_CELL;
  const cols = Math.max(1, Math.round((endX - originX) / MAP_ROUTE_CELL));
  const rows = Math.max(1, Math.round((endY - originY) / MAP_ROUTE_CELL));
  const blocked = new Uint8Array(cols * rows);
  const owner = new Int32Array(cols * rows).fill(-1);
  const clearance = 5;
  devices.forEach(dev => {
    const o = MAP_NODE_ORIGIN[dev.id], box = MAP_NODE_BOX[dev.id];
    if (!o || !box) return;
    const c0 = Math.max(0, Math.floor((o.x - clearance - originX) / MAP_ROUTE_CELL));
    const c1 = Math.min(cols, Math.ceil((o.x + box.width + clearance - originX) / MAP_ROUTE_CELL));
    const r0 = Math.max(0, Math.floor((o.y - clearance - originY) / MAP_ROUTE_CELL));
    const r1 = Math.min(rows, Math.ceil((o.y + box.height + clearance - originY) / MAP_ROUTE_CELL));
    for (let r = r0; r < r1; r++) {
      for (let c = c0; c < c1; c++) {
        blocked[r * cols + c] = 1;
        owner[r * cols + c] = dev.id;
      }
    }
  });
  return {
    originX, originY, cols, rows, blocked, owner,
    usage: {
      H: new Uint16Array(cols * rows), V: new Uint16Array(cols * rows),
      D1: new Uint16Array(cols * rows), D2: new Uint16Array(cols * rows),
    },
  };
}

// `rowSign` lets the caller pick which way to round the row when a jack's
// exact pixel y doesn't land on a grid line (it practically never does):
// 0 (default) rounds to the NEAREST row, same as before. A nonzero sign
// instead rounds toward that direction (+1 = down = ceil, -1 = up =
// floor), so the quantized cell never sits on the wrong side of the exact
// jack from where the cable is actually headed. Without this, the jack's
// own row could round to the opposite side by up to half a cell (~7px)
// regardless of the cable's real direction -- harmless for the A* path
// itself, but the lead-in/out stub connecting the exact jack pixel back
// to that row (see mapRouteOrthogonalize) would then have to visibly dip
// the "wrong" way for an instant before the path can turn back toward
// its real destination. Two cables sharing one jack (e.g. a patch
// panel's front/rear pair) but headed opposite directions would both
// show that same wrong-way dip, looking like neither one picked a side.
function mapRouteCellOf(grid, x, y, rowSign) {
  const c = Math.round((x - grid.originX) / MAP_ROUTE_CELL);
  const rawR = (y - grid.originY) / MAP_ROUTE_CELL;
  const r = rowSign > 0 ? Math.ceil(rawR) : rowSign < 0 ? Math.floor(rawR) : Math.round(rawR);
  return { r: Math.min(Math.max(r, 0), grid.rows - 1), c: Math.min(Math.max(c, 0), grid.cols - 1) };
}
function mapRouteCellXY(grid, r, c) {
  return { x: grid.originX + c * MAP_ROUTE_CELL, y: grid.originY + r * MAP_ROUTE_CELL };
}

// A stable per-undirected-edge key (same result regardless of which
// direction it's traversed), used both to read and to bump congestion.
function mapRouteEdgeKey(r, c, nr, nc, cols) {
  if (nr === r) { const cc = Math.min(c, nc); return { arr: "H", idx: r * cols + cc }; }
  if (nc === c) { const rr = Math.min(r, nr); return { arr: "V", idx: rr * cols + c }; }
  if ((nr - r) === (nc - c)) { const rr = Math.min(r, nr), cc = Math.min(c, nc); return { arr: "D1", idx: rr * cols + cc }; }
  const rr = Math.min(r, nr);
  const cc = (rr === r) ? c : nc;
  return { arr: "D2", idx: rr * cols + cc };
}

function mapRouteHeuristic(a, b) {
  const dx = Math.abs(a.c - b.c), dy = Math.abs(a.r - b.r);
  return (dx + dy) + (Math.SQRT2 - 2) * Math.min(dx, dy); // octile distance
}

// Only exempt a small neighborhood around one endpoint's own jack (not
// that device's whole footprint) from blocking -- just enough for a
// route to step out of the device to reach that specific jack cleanly,
// without turning the rest of a big multi-port box (e.g. a 24-port
// patch panel) into a shortcut other cables can cut through on their way
// to a different jack, which used to produce a tangle of crossing lines
// inside the box instead of each cable approaching its own port directly.
//
// The exemption is deliberately anisotropic, not a plain radius: jacks
// on a device sit in one or more horizontal rows (see mapBuildLayout), so
// a generous radius in every direction let a route slide *sideways*
// along the row through other ports' cells on its way to its own jack --
// exactly the "cable cuts across several unrelated ports before landing
// on its real one" look. MAP_ROUTE_EXEMPT_RADIUS_X stays at 0 -- the
// jack's own grid column only, nothing either side -- so a route can
// only approach a jack head-on from directly above/below it; ports sit
// much closer together (MAP_JACK, 22px) than the routing grid's own
// resolution (MAP_ROUTE_CELL, 14px), so even a 1-cell margin each side
// can still reach a neighboring jack. _Y is generous enough to span the
// device's whole box top-to-bottom regardless of how many port rows it
// has, so entry from either edge still reaches it.
//
// `exitSign` restricts that vertical slack to one side only: positive
// exits downward only, negative upward only, 0 (or omitted) keeps the
// old symmetric behavior. mapRouteCable passes whichever side is
// actually closer to the OTHER endpoint, so a jack exits toward its own
// destination instead of a fixed/arbitrary direction -- otherwise two
// cables that happen to share one physical jack (e.g. a patch panel's
// front/rear pair, see mapDevicePositions) could both get forced out the
// same side and overlap for a few cells before they're able to diverge.
const MAP_ROUTE_EXEMPT_RADIUS_X = 0;
const MAP_ROUTE_EXEMPT_RADIUS_Y = 6;
function mapRouteExemptCells(grid, cell, devId, exitSign) {
  const exempt = new Set();
  if (devId == null) return exempt;
  const { cols, rows, owner } = grid;
  const drMin = exitSign > 0 ? 0 : -MAP_ROUTE_EXEMPT_RADIUS_Y;
  const drMax = exitSign < 0 ? 0 : MAP_ROUTE_EXEMPT_RADIUS_Y;
  for (let dr = drMin; dr <= drMax; dr++) {
    for (let dc = -MAP_ROUTE_EXEMPT_RADIUS_X; dc <= MAP_ROUTE_EXEMPT_RADIUS_X; dc++) {
      const r = cell.r + dr, c = cell.c + dc;
      if (r < 0 || r >= rows || c < 0 || c >= cols) continue;
      const idx = r * cols + c;
      if (owner[idx] === devId) exempt.add(idx);
    }
  }
  return exempt;
}

// 8-directional A* from `start` to `end` (grid cells), treating cells in
// `exempt` as passable (so a route can leave/approach its own jack even
// though it sits inside a blocked device box) and clipped to `win` (a
// local search window) for speed; the caller retries with a wider
// window if this returns null.
function mapRouteAStar(grid, start, end, exempt, win) {
  const { cols, rows, blocked, usage } = grid;
  const startIdx = start.r * cols + start.c, endIdx = end.r * cols + end.c;
  const gScore = new Map([[startIdx, 0]]);
  const cameFrom = new Map(), cameDir = new Map();
  const closed = new Set();
  const open = new MapMinHeap();
  open.push(startIdx, mapRouteHeuristic(start, end));
  const isOwned = (idx) => exempt.has(idx);
  let guard = 0;
  while (open.size) {
    if (++guard > 60000) break; // safety valve on pathological grids
    const cur = open.pop();
    if (cur === endIdx) break;
    if (closed.has(cur)) continue;
    closed.add(cur);
    const r = Math.floor(cur / cols), c = cur % cols;
    for (let di = 0; di < MAP_ROUTE_DIRS.length; di++) {
      const [dr, dc, baseCost] = MAP_ROUTE_DIRS[di];
      const nr = r + dr, nc = c + dc;
      if (nr < win.rMin || nr > win.rMax || nc < win.cMin || nc > win.cMax) continue;
      if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
      const nIdx = nr * cols + nc;
      if (closed.has(nIdx)) continue;
      if (blocked[nIdx] && !isOwned(nIdx) && nIdx !== endIdx) continue;
      if (dr !== 0 && dc !== 0) {
        // Don't let a diagonal step cut through the corner of two
        // orthogonally-blocked cells.
        const s1 = r * cols + nc, s2 = nr * cols + c;
        const b1 = blocked[s1] && !isOwned(s1), b2 = blocked[s2] && !isOwned(s2);
        if (b1 && b2) continue;
      }
      const ek = mapRouteEdgeKey(r, c, nr, nc, cols);
      const congestion = usage[ek.arr][ek.idx] || 0;
      const turnPenalty = (cameDir.has(cur) && cameDir.get(cur) !== di) ? MAP_ROUTE_TURN_PENALTY : 0;
      const stepCost = baseCost + congestion * MAP_ROUTE_CONGESTION_WEIGHT + turnPenalty;
      const tentative = gScore.get(cur) + stepCost;
      if (tentative < (gScore.has(nIdx) ? gScore.get(nIdx) : Infinity)) {
        gScore.set(nIdx, tentative);
        cameFrom.set(nIdx, cur);
        cameDir.set(nIdx, di);
        open.push(nIdx, tentative + mapRouteHeuristic({ r: nr, c: nc }, end));
      }
    }
  }
  if (!gScore.has(endIdx)) return null;
  const path = [];
  let cur = endIdx;
  while (cur !== undefined) {
    path.push({ r: Math.floor(cur / cols), c: cur % cols });
    if (cur === startIdx) break;
    cur = cameFrom.get(cur);
  }
  path.reverse();
  return path;
}

// Progressively widens the search window around the two endpoints so the
// common case (nothing in the way) stays fast, while a route that needs a
// long detour still eventually finds one.
function mapRouteCable(grid, aCell, bCell, aDevId, bDevId) {
  // Exit toward whichever side is actually closer to the other endpoint
  // (see mapRouteExemptCells) -- 0 (same row, or exactly unclear) falls
  // back to the old either-direction behavior.
  const aSign = bCell.r === aCell.r ? 0 : Math.sign(bCell.r - aCell.r);
  const bSign = aCell.r === bCell.r ? 0 : Math.sign(aCell.r - bCell.r);
  const path = mapRouteCableTry(grid, aCell, bCell, aDevId, bDevId, aSign, bSign);
  if (path) return path;
  // The directional bias above can occasionally box a route in
  // entirely -- e.g. the only actual way out is the "wrong" side (a
  // device backed up against the edge of everything else on the map) --
  // in which case fall back to the old symmetric (either-direction)
  // exemption rather than ever leaving a cable unrouted (which would
  // fall all the way back to a raw straight line cutting across the
  // whole diagram -- see the "boxed in somehow" fallback below).
  if (aSign !== 0 || bSign !== 0) return mapRouteCableTry(grid, aCell, bCell, aDevId, bDevId, 0, 0);
  return null;
}

function mapRouteCableTry(grid, aCell, bCell, aDevId, bDevId, aSign, bSign) {
  const exemptA = mapRouteExemptCells(grid, aCell, aDevId, aSign);
  const exemptB = mapRouteExemptCells(grid, bCell, bDevId, bSign);
  const exempt = exemptA.size && exemptB.size ? new Set([...exemptA, ...exemptB]) : (exemptA.size ? exemptA : exemptB);
  const marginsPx = [150, 400, Infinity];
  for (const marginPx of marginsPx) {
    const m = marginPx === Infinity ? Math.max(grid.rows, grid.cols) : Math.ceil(marginPx / MAP_ROUTE_CELL);
    const win = {
      rMin: Math.max(0, Math.min(aCell.r, bCell.r) - m),
      rMax: Math.min(grid.rows - 1, Math.max(aCell.r, bCell.r) + m),
      cMin: Math.max(0, Math.min(aCell.c, bCell.c) - m),
      cMax: Math.min(grid.cols - 1, Math.max(aCell.c, bCell.c) + m),
    };
    const path = mapRouteAStar(grid, aCell, bCell, exempt, win);
    if (path) return path;
  }
  return null;
}

function mapRouteMarkUsage(grid, cellPath) {
  for (let i = 0; i < cellPath.length - 1; i++) {
    const a = cellPath[i], b = cellPath[i + 1];
    const ek = mapRouteEdgeKey(a.r, a.c, b.r, b.c, grid.cols);
    grid.usage[ek.arr][ek.idx] = (grid.usage[ek.arr][ek.idx] || 0) + 1;
  }
}

// Collapses collinear runs of points down to just the actual turn
// points, so a long straight (or diagonal) run renders as one segment
// instead of dozens of tiny ones.
function mapSimplifyPolyline(pts) {
  if (pts.length <= 2) return pts;
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const prev = out[out.length - 1], cur = pts[i], next = pts[i + 1];
    const cross = (cur.x - prev.x) * (next.y - cur.y) - (cur.y - prev.y) * (next.x - cur.x);
    if (Math.abs(cross) > 0.01) out.push(cur);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

function mapRouteSimplify(grid, cellPath) {
  return mapSimplifyPolyline(cellPath.map(({ r, c }) => mapRouteCellXY(grid, r, c)));
}

// A jack's exact pixel position almost never lands precisely on the
// routing grid, so the short stub connecting it to the nearest grid
// point is usually some arbitrary little vector -- not a 45-degree
// multiple. This replaces that one stub with an L-shaped pair of
// segments (one purely horizontal, one purely vertical) so the whole
// path, lead-in stub included, only ever turns at 45 or 90 degrees.
// Returns [a, b] unchanged if the direct line is already aligned.
//
// `jackIsA` says which end is the exact jack (true for a lead-in, where
// the route starts at the jack; false for a lead-out, where it ends at
// one) -- the elbow always goes at {jack's x, other point's y}, so the
// segment touching the jack is the VERTICAL leg and the horizontal leg
// stays out at the grid point's y, away from the jack's own row. Jacks
// on a device always sit in a horizontal row (see mapBuildLayout), so
// picking the elbow by whichever of dx/dy was larger (the old approach)
// could send the horizontal leg right along the jack's row at its own
// y -- visually cutting across whatever other jacks were in the way.
function mapRouteOrthogonalize(a, b, jackIsA) {
  const dx = b.x - a.x, dy = b.y - a.y;
  if (Math.abs(dx) < 0.05 || Math.abs(dy) < 0.05 || Math.abs(Math.abs(dx) - Math.abs(dy)) < 0.05) {
    return [a, b];
  }
  const elbow = jackIsA ? { x: a.x, y: b.y } : { x: b.x, y: a.y };
  return [a, elbow, b];
}

function mapPolylinePath(points) {
  return points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
}

function mapPointInBox(p, origin, box) {
  return p.x >= origin.x && p.x <= origin.x + box.width && p.y >= origin.y && p.y <= origin.y + box.height;
}

// Cable edges are now drawn ON TOP of device boxes (so a cable stays
// visible as it runs into its own endpoint's box to reach an interior
// port -- see drawMap's layering comment). That means a single fat,
// generously-clickable hit path for the *whole* cable would also sit on
// top of the open interior of whichever device box the lead-in/lead-out
// happens to cross, stealing clicks meant for the device itself. Splits
// the polyline into the small "inside a device's own box" end stretches
// (walked from each end while points stay inside that device's box) and
// the "open canvas" middle stretch, so only the middle gets the generous
// 12px hit width -- the two end stretches get a slimmer one, just enough
// to click the cable deliberately without blanketing the box.
function mapHitSplit(points, aBox, bBox) {
  const n = points.length;
  let i = 0;
  if (aBox) {
    while (i < n - 1 && mapPointInBox(points[i], aBox.origin, aBox.box)) i++;
  }
  let j = n - 1;
  if (bBox) {
    while (j > 0 && mapPointInBox(points[j], bBox.origin, bBox.box)) j--;
  }
  if (i > j) { i = j; } // degenerate (very short route, or overlapping boxes)
  return {
    thinA: points.slice(0, i + 1),
    fatMid: points.slice(i, j + 1),
    thinB: points.slice(j, n),
  };
}

// Each cable is a group with invisible "hit" paths (SVG hit-testing only
// covers what's actually painted, and a 1.6px line is hard to click)
// plus the thin path that's actually seen. The hit area is split into a
// generous 12px-wide stretch over open canvas and slimmer 6px stretches
// over the bit that dips inside each endpoint device's own box (see
// mapHitSplit) so it stays easy to click the cable near a port without
// making it hard to click the device box underneath it elsewhere.
// data-a-port/data-b-port stay on the group purely so a live drag can
// swap in a cheap straight-line preview (see mapUpdateEdgesForDevice)
// before the real route is recomputed on drop.
function mapCableSVG(c, points, highlighted) {
  if (!points || points.length < 2) return "";
  const d = mapPolylinePath(points);
  const stroke = highlighted ? "#2563eb" : "#94a3b8";
  const width = highlighted ? 3 : 1.6;
  const aOrigin = MAP_NODE_ORIGIN[c.a_device_id], aBoxDim = MAP_NODE_BOX[c.a_device_id];
  const bOrigin = MAP_NODE_ORIGIN[c.b_device_id], bBoxDim = MAP_NODE_BOX[c.b_device_id];
  const aBox = aOrigin && aBoxDim ? { origin: aOrigin, box: aBoxDim } : null;
  const bBox = bOrigin && bBoxDim ? { origin: bOrigin, box: bBoxDim } : null;
  const { thinA, fatMid, thinB } = mapHitSplit(points, aBox, bBox);
  const hitParts = [];
  if (thinA.length >= 2) hitParts.push(`<path class="map-edge-hit" d="${mapPolylinePath(thinA)}" fill="none" stroke="transparent" stroke-width="6"></path>`);
  if (fatMid.length >= 2) hitParts.push(`<path class="map-edge-hit" d="${mapPolylinePath(fatMid)}" fill="none" stroke="transparent" stroke-width="12"></path>`);
  if (thinB.length >= 2) hitParts.push(`<path class="map-edge-hit" d="${mapPolylinePath(thinB)}" fill="none" stroke="transparent" stroke-width="6"></path>`);
  return `<g class="map-edge" data-cable-id="${c.id}" data-a-port="${c.a_port_id}" data-b-port="${c.b_port_id}">
    ${hitParts.join("")}
    <path class="map-edge-line" d="${d}" fill="none" stroke="${stroke}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"></path>
  </g>`;
}

function mapCollectVLinks(devices) {
  const out = [];
  devices.forEach(dev => {
    if (!VIRTUAL_SWITCH_ROLES.includes(dev.role)) return;
    // Members (ports whose *only* connection is this virtual switch) and
    // uplinks (a real port elsewhere that keeps its own cable too, but
    // also bridges into this virtual switch -- see db.py's schema notes
    // on virtual_switch_uplinks) both get a dashed virtual-link line to
    // the switch's anchor. Without the uplink half of this, an AP Group
    // or Virtual Switch whose members are all wireless/virtual (nothing
    // but other dashed lines) renders with no visible connection at all,
    // even when it has a perfectly real uplink back to its host.
    if (dev.members) dev.members.forEach(m => out.push({ port_id: m.port_id, device_id: m.device_id, vs_id: dev.id }));
    if (dev.uplinks) dev.uplinks.forEach(u => out.push({ port_id: u.port_id, device_id: u.device_id, vs_id: dev.id }));
  });
  return out;
}

// Like mapCableSVG: `points` is the already-routed polyline (same grid
// router cables use -- see drawMap), so a virtual link no longer draws a
// raw straight line that can cut straight through an unrelated device's
// box sitting between the member/uplink and the switch. That mattered
// for more than looks: a plain SVG line is hit-testable along its own
// paint by default, so a vlink crossing a device box could silently eat
// clicks meant for that device (reported as "clicking the map is not
// opening some devices" -- the AP Group's long uplink line happened to
// run right over the Internet node's box). mapHitSplit keeps that from
// recurring the same way it already does for cables.
function mapVLinkSVG(vl, points, highlighted) {
  if (!points || points.length < 2) return "";
  const d = mapPolylinePath(points);
  const stroke = highlighted ? "#2563eb" : "#94a3b8";
  const aOrigin = MAP_NODE_ORIGIN[vl.device_id], aBoxDim = MAP_NODE_BOX[vl.device_id];
  const bOrigin = MAP_NODE_ORIGIN[vl.vs_id], bBoxDim = MAP_NODE_BOX[vl.vs_id];
  const aBox = aOrigin && aBoxDim ? { origin: aOrigin, box: aBoxDim } : null;
  const bBox = bOrigin && bBoxDim ? { origin: bOrigin, box: bBoxDim } : null;
  const { thinA, fatMid } = mapHitSplit(points, aBox, bBox);
  const hitParts = [];
  if (thinA.length >= 2) hitParts.push(`<path class="map-edge-hit" d="${mapPolylinePath(thinA)}" fill="none" stroke="transparent" stroke-width="6"></path>`);
  if (fatMid.length >= 2) hitParts.push(`<path class="map-edge-hit" d="${mapPolylinePath(fatMid)}" fill="none" stroke="transparent" stroke-width="12"></path>`);
  // No hit path at all over the stretch inside the switch's OWN box
  // (thinB, discarded) -- unlike a real cable endpoint, a virtual
  // switch has no physical jack for this line to legitimately enter,
  // it just terminates at mapAnchorAbs's center point, so clicking
  // anywhere on the switch's node should always open the device, never
  // the vlink popover.
  return `<g class="map-vlink" data-vport="${vl.port_id}" data-vdevice="${vl.vs_id}">
    ${hitParts.join("")}
    <path class="map-vlink-line" d="${d}" fill="none" stroke="${stroke}" stroke-width="1.4" stroke-dasharray="4 3" pointer-events="none"></path>
  </g>`;
}

function mapFilteredDevices() {
  const sel = document.getElementById("map_siteFilter");
  const site = sel ? sel.value : "";
  const hl = MAP_HIGHLIGHT;
  // A highlighted path always renders in full, even across a site filter
  // or a hidden (e.g. Client) device -- otherwise "Show on map" from the
  // path finder could silently drop part of the route.
  return MAP_DATA.devices.filter(d => {
    if (hl && hl.deviceIds.has(d.id)) return true;
    if (site && d.site !== site) return false;
    if (!d.show_on_map) return false;
    return true;
  });
}

// Bounding box (in world/layout coordinates) of a set of device ids,
// using whatever's already in MAP_NODE_ORIGIN/MAP_NODE_BOX -- call
// mapBuildLayout() first.
function mapBoundsFor(deviceIds) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  deviceIds.forEach(id => {
    const o = MAP_NODE_ORIGIN[id], box = MAP_NODE_BOX[id];
    if (!o || !box) return;
    minX = Math.min(minX, o.x); minY = Math.min(minY, o.y);
    maxX = Math.max(maxX, o.x + box.width); maxY = Math.max(maxY, o.y + box.height);
  });
  return isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

// Sets MAP_VIEW so the given world-space bounds are centered and fully
// visible in the current SVG viewport.
function mapApplyFit(bounds, padding, maxScale) {
  if (!bounds) return;
  const svg = document.getElementById("mapSvg");
  const vw = svg.clientWidth || 900, vh = svg.clientHeight || 640;
  const bw = (bounds.maxX - bounds.minX) + padding * 2, bh = (bounds.maxY - bounds.minY) + padding * 2;
  const scale = Math.max(0.1, Math.min(maxScale, Math.min(vw / bw, vh / bh)));
  MAP_VIEW.scale = scale;
  MAP_VIEW.tx = -((bounds.minX - padding) * scale) + (vw - bw * scale) / 2;
  MAP_VIEW.ty = -((bounds.minY - padding) * scale) + (vh - bh * scale) / 2;
}

function mapFitToHighlight() {
  if (!MAP_HIGHLIGHT || !MAP_HIGHLIGHT.deviceIds.size) return;
  mapApplyFit(mapBoundsFor(MAP_HIGHLIGHT.deviceIds), 70, 1.8);
}

function mapFitToAll(devices) {
  mapApplyFit(mapBoundsFor(devices.map(d => d.id)), 60, 1.2);
}

function drawMap(opts) {
  opts = opts || {};
  // svg.innerHTML gets replaced wholesale below, so any element the
  // hover state above still references is about to be detached.
  MAP_HOVER_EL = null;
  const devices = mapFilteredDevices();
  mapBuildLayout(devices);
  if (opts.fit === "highlight") mapFitToHighlight();
  else if (opts.fit === "all") mapFitToAll(devices);
  // Otherwise (e.g. a redraw right after a drag) keep whatever pan/zoom
  // the user currently has -- only an explicit fit should move the camera.
  MAP_CABLED_PORTS = mapCabledPortIds(MAP_DATA);

  const deviceIds = new Set(devices.map(d => d.id));
  const cables = MAP_DATA.cables
    .filter(c => deviceIds.has(c.a_device_id) && deviceIds.has(c.b_device_id))
    .slice()
    .sort((x, y) => x.id - y.id); // stable order so routing doesn't jitter between redraws
  const vlinks = mapCollectVLinks(devices);
  const hl = MAP_HIGHLIGHT;

  const grid = mapBuildRouteGrid(devices);
  const edgesHTML = cables.map(c => {
    const a = mapJackAbs(c.a_port_id) || mapAnchorAbs(c.a_device_id);
    const b = mapJackAbs(c.b_port_id) || mapAnchorAbs(c.b_device_id);
    if (!a || !b) return "";
    // Round each endpoint's row toward its OWN actual direction (see
    // mapRouteCellOf) -- from the exact jack pixels, not the as-yet-
    // unquantized cells, so a tie rounds the same way the exempt bias
    // below will.
    const rowSign = a.y === b.y ? 0 : Math.sign(b.y - a.y);
    const aCell = mapRouteCellOf(grid, a.x, a.y, rowSign), bCell = mapRouteCellOf(grid, b.x, b.y, -rowSign);
    const cellPath = mapRouteCable(grid, aCell, bCell, c.a_device_id, c.b_device_id);
    let points;
    if (cellPath && cellPath.length) {
      mapRouteMarkUsage(grid, cellPath);
      const grid_pts = mapRouteSimplify(grid, cellPath);
      // Swap the arbitrary stub between the exact jack and the nearest
      // grid point for an orthogonal lead-in/out, so even that stub
      // only ever turns at 45/90 degrees (see mapRouteOrthogonalize).
      const leadIn = mapRouteOrthogonalize(a, grid_pts[0], true);
      leadIn.pop();
      const leadOut = mapRouteOrthogonalize(grid_pts[grid_pts.length - 1], b, false);
      leadOut.shift();
      points = mapSimplifyPolyline([...leadIn, ...grid_pts, ...leadOut]);
    } else {
      points = [a, b]; // boxed in somehow -- fall back to a straight line
    }
    return mapCableSVG(c, points, !!(hl && hl.cableIds.has(c.id)));
  }).join("");
  const vlinksHTML = vlinks.map(vl => {
    const a = mapJackAbs(vl.port_id);
    const b = mapAnchorAbs(vl.vs_id);
    if (!a || !b) return "";
    // Routed through the same grid the cables above use (see
    // mapRouteCable) instead of a raw straight line, so a virtual link
    // doesn't cut through -- and intercept clicks on -- some unrelated
    // device sitting between the member/uplink and the switch.
    const rowSign = a.y === b.y ? 0 : Math.sign(b.y - a.y);
    const aCell = mapRouteCellOf(grid, a.x, a.y, rowSign), bCell = mapRouteCellOf(grid, b.x, b.y, -rowSign);
    const cellPath = mapRouteCable(grid, aCell, bCell, vl.device_id, vl.vs_id);
    let points;
    if (cellPath && cellPath.length) {
      mapRouteMarkUsage(grid, cellPath);
      const grid_pts = mapRouteSimplify(grid, cellPath);
      const leadIn = mapRouteOrthogonalize(a, grid_pts[0], true);
      leadIn.pop();
      const leadOut = mapRouteOrthogonalize(grid_pts[grid_pts.length - 1], b, false);
      leadOut.shift();
      points = mapSimplifyPolyline([...leadIn, ...grid_pts, ...leadOut]);
    } else {
      points = [a, b]; // boxed in somehow -- fall back to a straight line
    }
    return mapVLinkSVG(vl, points, !!(hl && hl.jackKeys.has(vl.port_id)));
  }).join("");
  const boxesHTML = devices.map(d => mapNodeBoxSVG(d)).join("");
  const jacksHTML = devices.map(d => mapNodeJacksSVG(d)).join("");

  const svg = document.getElementById("mapSvg");
  // Layer order matters: boxes first, then edges/vlinks on top of them
  // (so a cable is visible running into its own endpoint's box instead
  // of disappearing behind it), then jacks on top of everything (so the
  // port dot itself is never obscured by the line ending at it).
  svg.innerHTML = `<g id="mapViewport" transform="translate(${MAP_VIEW.tx},${MAP_VIEW.ty}) scale(${MAP_VIEW.scale})">${boxesHTML}${edgesHTML}${vlinksHTML}${jacksHTML}</g>`;
}

function mapApplyViewport() {
  const vp = document.getElementById("mapViewport");
  if (vp) vp.setAttribute("transform", `translate(${MAP_VIEW.tx},${MAP_VIEW.ty}) scale(${MAP_VIEW.scale})`);
}

function mapZoomAt(factor, mx, my) {
  const newScale = Math.max(0.2, Math.min(3, MAP_VIEW.scale * factor));
  const worldX = (mx - MAP_VIEW.tx) / MAP_VIEW.scale;
  const worldY = (my - MAP_VIEW.ty) / MAP_VIEW.scale;
  MAP_VIEW.scale = newScale;
  MAP_VIEW.tx = mx - worldX * newScale;
  MAP_VIEW.ty = my - worldY * newScale;
  mapApplyViewport();
}
function mapZoom(factor) {
  const svg = document.getElementById("mapSvg");
  const rect = svg.getBoundingClientRect();
  mapZoomAt(factor, rect.width / 2, rect.height / 2);
}
function mapResetView() {
  mapFitToAll(mapFilteredDevices());
  mapApplyViewport();
}

// Printing the Map tab needs the WHOLE diagram, not just whatever's
// currently panned/zoomed into the on-screen viewport (which is clipped
// to a fixed-height box on screen -- see .map-canvas-wrap). Rather than
// fiddle with MAP_VIEW (which drives interactive panning/zooming), this
// temporarily points the <svg> itself at the full content bounds via
// viewBox, independent of MAP_VIEW, so the browser's print layout scales
// the whole thing to fit the page (preserving aspect ratio) instead of
// printing a cropped screenshot of the current pan position. See
// .map-canvas-wrap / #mapSvg under @media print in style.css for the
// companion CSS that lets it actually render at full size on the page.
function printMap() {
  const svg = document.getElementById("mapSvg");
  if (!svg) { window.print(); return; }
  const devices = mapFilteredDevices();
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  devices.forEach(d => {
    const o = MAP_NODE_ORIGIN[d.id], b = MAP_NODE_BOX[d.id];
    if (!o || !b) return;
    minX = Math.min(minX, o.x); minY = Math.min(minY, o.y);
    maxX = Math.max(maxX, o.x + b.width); maxY = Math.max(maxY, o.y + b.height);
  });
  if (!isFinite(minX)) { minX = 0; minY = 0; maxX = 100; maxY = 100; }
  const pad = 20;
  svg.setAttribute("viewBox", `${minX - pad} ${minY - pad} ${maxX - minX + pad * 2} ${maxY - minY + pad * 2}`);
  window.print();
}
// Printing itself (window.print()) is what actually applies @media
// print, so the viewBox override above only needs to be gone by the time
// the dialog closes -- afterprint fires then, whether the user printed
// or cancelled.
window.addEventListener("afterprint", () => {
  const svg = document.getElementById("mapSvg");
  if (svg && svg.hasAttribute("viewBox")) svg.removeAttribute("viewBox");
});

function mapUpdateEdgesForDevice(devId) {
  const svg = document.getElementById("mapSvg");
  svg.querySelectorAll(".map-edge").forEach(g => {
    const aPort = Number(g.dataset.aPort), bPort = Number(g.dataset.bPort);
    const aOwner = MAP_PORT_JACK[aPort] && MAP_PORT_JACK[aPort].devId;
    const bOwner = MAP_PORT_JACK[bPort] && MAP_PORT_JACK[bPort].devId;
    if (aOwner !== devId && bOwner !== devId) return;
    const a = mapJackAbs(aPort), b = mapJackAbs(bPort);
    if (!a || !b) return;
    // Live-drag preview only: a plain straight line, so moving a node
    // doesn't re-run the router on every pointer event. drawMap() on
    // drop (see the pointerup handler) replaces this with the real
    // orthogonal route.
    const d = `M${a.x.toFixed(1)},${a.y.toFixed(1)} L${b.x.toFixed(1)},${b.y.toFixed(1)}`;
    g.querySelectorAll("path").forEach(path => path.setAttribute("d", d));
  });
  svg.querySelectorAll(".map-vlink").forEach(g => {
    const vport = Number(g.dataset.vport), vdev = Number(g.dataset.vdevice);
    const owner = MAP_PORT_JACK[vport] && MAP_PORT_JACK[vport].devId;
    if (owner !== devId && vdev !== devId) return;
    const a = mapJackAbs(vport), b = mapAnchorAbs(vdev);
    if (!a || !b) return;
    // Same live-drag-preview shortcut as cables above: a plain straight
    // line while dragging, re-routed for real by drawMap() on drop.
    const d = `M${a.x.toFixed(1)},${a.y.toFixed(1)} L${b.x.toFixed(1)},${b.y.toFixed(1)}`;
    g.querySelectorAll("path").forEach(path => path.setAttribute("d", d));
  });
}

function mapMoveNodeTo(devId, x, y) {
  MAP_NODE_ORIGIN[devId] = { x, y };
  const g = document.getElementById(`mapNode-${devId}`);
  if (g) g.setAttribute("transform", `translate(${x},${y})`);
  const jacksG = document.getElementById(`mapNodeJacks-${devId}`);
  if (jacksG) jacksG.setAttribute("transform", `translate(${x},${y})`);
  mapUpdateEdgesForDevice(devId);
}

function mapCableForPort(portId) {
  return MAP_DATA.cables.find(c => c.a_port_id === portId || c.b_port_id === portId);
}

function mapShowPopover(e, html) {
  const pop = document.getElementById("mapPopover");
  pop.innerHTML = html;
  pop.style.display = "block";
  const wrap = document.getElementById("mapCanvasWrap").getBoundingClientRect();
  const left = Math.max(4, Math.min(e.clientX - wrap.left + 12, wrap.width - 260));
  const top = Math.max(4, Math.min(e.clientY - wrap.top + 12, wrap.height - 120));
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
}

function mapShowJackPopover(jackEl, e) {
  const portIds = jackEl.dataset.ports.split(",").map(Number);
  const devId = Number(jackEl.dataset.dev);
  const dev = MAP_DATA.devices.find(d => d.id === devId);
  if (!dev) return;
  const rows = portIds.map(pid => {
    const p = MAP_PORT_BY_ID[pid];
    if (!p) return "";
    const cable = mapCableForPort(pid);
    let other;
    if (cable) {
      const otherName = cable.a_port_id === pid ? cable.b_device_name : cable.a_device_name;
      const otherPort = cable.a_port_id === pid ? cable.b_port_name : cable.a_port_name;
      other = `&rarr; ${esc(otherName)} (${esc(cleanPortLabel(otherPort))})`;
    } else if (p.virtual_switch_id) {
      const vs = MAP_DATA.devices.find(d => d.id === p.virtual_switch_id);
      other = `&rarr; ${esc(vs ? vs.name : "virtual switch")} <span class="note">(wireless/virtual link)</span>`;
    } else {
      other = `<span class="note">not connected</span>`;
    }
    return `<div class="map-pop-row"><span class="port-name">${esc(cleanPortLabel(p.name))}</span> ${p.speed ? speedTag(p.speed) : ""} ${p.poe_supply ? poeSupplyTag(true) : ""}<br>${other}</div>`;
  }).join("");
  mapShowPopover(e, `<div class="map-pop-title"><a class="link" onclick="viewDevice(${devId})">${esc(dev.name)}</a> ${roleBadge(dev.role)}</div>${rows}`);
}

function mapShowCablePopover(edgeEl, e) {
  const c = MAP_DATA.cables.find(x => x.id === Number(edgeEl.dataset.cableId));
  if (!c) return;
  mapShowPopover(e, `
    <div class="map-pop-title">Cable${c.label ? ": " + esc(c.label) : ""}</div>
    <div class="map-pop-row"><a class="link" onclick="viewDevice(${c.a_device_id})">${esc(c.a_device_name)}</a><br><span class="port-name">${esc(cleanPortLabel(c.a_port_name))}</span></div>
    <div class="map-pop-row"><a class="link" onclick="viewDevice(${c.b_device_id})">${esc(c.b_device_name)}</a><br><span class="port-name">${esc(cleanPortLabel(c.b_port_name))}</span></div>
    <div class="map-pop-row">${c.effective_speed ? speedTag(c.effective_speed) : `<span class="note">speed not tagged</span>`}</div>`);
}

function mapShowVLinkPopover(vlinkEl, e) {
  const portId = Number(vlinkEl.dataset.vport), vsId = Number(vlinkEl.dataset.vdevice);
  const p = MAP_PORT_BY_ID[portId];
  const vs = MAP_DATA.devices.find(d => d.id === vsId);
  if (!p || !vs) return;
  mapShowPopover(e, `
    <div class="map-pop-title">Wireless / virtual link</div>
    <div class="map-pop-row"><a class="link" onclick="viewDevice(${p.device_id})">${esc(p.device_name)}</a><br><span class="port-name">${esc(cleanPortLabel(p.name))}</span></div>
    <div class="map-pop-row"><a class="link" onclick="viewDevice(${vsId})">${esc(vs.name)}</a> ${roleBadge(vs.role)}</div>`);
}

// Highlights whichever cable/vlink group is currently under the pointer
// (or clears the highlight when `el` is null) and raises it to the very
// top of the SVG's paint order -- appendChild on an already-attached
// node just moves it to be its parent's last child, no clone/re-render
// involved, so this is cheap to call on every pointermove.
function mapSetHoverEdge(el) {
  if (MAP_HOVER_EL === el) return;
  if (MAP_HOVER_EL) MAP_HOVER_EL.classList.remove("map-line-hover");
  MAP_HOVER_EL = el;
  if (MAP_HOVER_EL) {
    MAP_HOVER_EL.classList.add("map-line-hover");
    MAP_HOVER_EL.parentNode.appendChild(MAP_HOVER_EL);
  }
}

function mapAttachHandlers(svg) {
  svg.addEventListener("wheel", (e) => {
    e.preventDefault();
    const rect = svg.getBoundingClientRect();
    mapZoomAt(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX - rect.left, e.clientY - rect.top);
  }, { passive: false });

  svg.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".map-jack, .map-edge, .map-vlink")) return;
    const nodeEl = e.target.closest(".map-node");
    if (nodeEl && isAdmin()) {
      const devId = Number(nodeEl.dataset.deviceId);
      const origin = MAP_NODE_ORIGIN[devId];
      svg.setPointerCapture(e.pointerId);
      MAP_DRAG = { devId, startX: e.clientX, startY: e.clientY, origX: origin.x, origY: origin.y, moved: false };
      e.preventDefault();
    } else if (!nodeEl) {
      svg.setPointerCapture(e.pointerId);
      MAP_PAN = { startX: e.clientX, startY: e.clientY, origTx: MAP_VIEW.tx, origTy: MAP_VIEW.ty };
    }
  });

  svg.addEventListener("pointermove", (e) => {
    if (MAP_DRAG) {
      const dx = (e.clientX - MAP_DRAG.startX) / MAP_VIEW.scale;
      const dy = (e.clientY - MAP_DRAG.startY) / MAP_VIEW.scale;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) MAP_DRAG.moved = true;
      mapMoveNodeTo(MAP_DRAG.devId, MAP_DRAG.origX + dx, MAP_DRAG.origY + dy);
    } else if (MAP_PAN) {
      MAP_VIEW.tx = MAP_PAN.origTx + (e.clientX - MAP_PAN.startX);
      MAP_VIEW.ty = MAP_PAN.origTy + (e.clientY - MAP_PAN.startY);
      mapApplyViewport();
    } else {
      // Idle hover: highlight whichever cable/vlink is under the cursor,
      // same elementFromPoint pattern the click handler uses (real DOM
      // hit-test, not e.target, which pointer capture can retarget).
      const real = document.elementFromPoint(e.clientX, e.clientY);
      const hoverEl = real && (real.closest(".map-edge") || real.closest(".map-vlink"));
      mapSetHoverEdge(hoverEl || null);
    }
  });

  svg.addEventListener("pointerleave", () => mapSetHoverEdge(null));

  svg.addEventListener("pointerup", async (e) => {
    // Release capture before the click event fires -- otherwise a
    // captured pointer retargets the click to the <svg> itself instead
    // of the node/jack/edge actually under the cursor, and a plain
    // (non-dragging) click on a device silently does nothing.
    if (svg.hasPointerCapture && svg.hasPointerCapture(e.pointerId)) svg.releasePointerCapture(e.pointerId);
    if (MAP_DRAG) {
      const { devId, moved } = MAP_DRAG;
      MAP_DRAG = null;
      if (moved) {
        MAP_SUPPRESS_CLICK = true;
        const origin = MAP_NODE_ORIGIN[devId], box = MAP_NODE_BOX[devId];
        const x = origin.x + box.width / 2, y = origin.y + box.height / 2;
        try {
          await api(`/api/devices/${devId}/position`, {
            method: "PUT",
            body: JSON.stringify({ x, y }),
          });
          // The PUT above only updates the server; MAP_DATA.devices is a
          // plain in-memory snapshot that nothing else refreshes, so
          // without this the drawMap() call below re-derives the layout
          // from the device's *old* (or still-null) pos_x/pos_y and the
          // node visually snaps right back to wherever it was before the
          // drag, undoing the drop entirely.
          const dev = MAP_DATA.devices.find(d => d.id === devId);
          if (dev) { dev.pos_x = x; dev.pos_y = y; }
        } catch (err) { showToast(err.message, true); }
        drawMap(); // swap the straight-line drag preview for the real routed paths, keeping the current view
      }
    }
    MAP_PAN = null;
  });

  svg.addEventListener("click", (e) => {
    if (MAP_SUPPRESS_CLICK) { MAP_SUPPRESS_CLICK = false; return; }
    // A node drag calls setPointerCapture on the svg so dragging works
    // past the node's own edges; browsers retarget the *click* event
    // itself to the capturing element for the rest of that gesture, so
    // e.target here can be the <svg> even when the user just clicked a
    // node/jack/edge without dragging. elementFromPoint does a real,
    // uncaptured hit-test at the actual cursor position instead.
    const real = document.elementFromPoint(e.clientX, e.clientY) || e.target;
    const jackEl = real.closest(".map-jack");
    if (jackEl) { mapShowJackPopover(jackEl, e); return; }
    const edgeEl = real.closest(".map-edge");
    if (edgeEl) { mapShowCablePopover(edgeEl, e); return; }
    const vlinkEl = real.closest(".map-vlink");
    if (vlinkEl) { mapShowVLinkPopover(vlinkEl, e); return; }
    const nodeEl = real.closest(".map-node");
    if (nodeEl) { viewDevice(Number(nodeEl.dataset.deviceId)); return; }
    document.getElementById("mapPopover").style.display = "none";
  });
}

function updateMapHighlightNote() {
  const note = document.getElementById("map_highlightNote");
  if (note) note.style.display = MAP_HIGHLIGHT ? "" : "none";
}

function clearMapHighlight() {
  MAP_HIGHLIGHT = null;
  drawMap({ fit: "all" });
  updateMapHighlightNote();
}

// Turns a /api/path result into the set of device/jack/cable ids to
// highlight, by walking its segments in order and looking up the cable
// connecting each segment boundary (an internal rear->front patch-panel
// pairing has no cable of its own, so it's simply skipped).
function computeHighlightFromPath(p) {
  const deviceIds = new Set(), jackKeys = new Set(), cableIds = new Set();
  const flatPorts = [];
  p.segments.forEach(seg => {
    deviceIds.add(seg.device_id);
    seg.ports.forEach(pp => { if (pp.port_id != null) { jackKeys.add(pp.port_id); flatPorts.push(pp.port_id); } });
  });
  const cableByPair = {};
  MAP_DATA.cables.forEach(c => { cableByPair[[c.a_port_id, c.b_port_id].sort((x, y) => x - y).join(":")] = c.id; });
  for (let i = 0; i < flatPorts.length - 1; i++) {
    const key = [flatPorts[i], flatPorts[i + 1]].sort((x, y) => x - y).join(":");
    if (cableByPair[key] != null) cableIds.add(cableByPair[key]);
  }
  return { deviceIds, jackKeys, cableIds };
}

function showPathOnMap() {
  if (!LAST_PATH_RESULT) return;
  PENDING_MAP_HIGHLIGHT = LAST_PATH_RESULT;
  navigateTo({ tab: "map" });
}

function mapShellHTML() {
  const sites = Array.from(new Set(MAP_DATA.devices.map(d => d.site).filter(Boolean))).sort();
  return `
  <div class="card map-card">
    <div class="map-toolbar">
      <select id="map_siteFilter" onchange="drawMap({fit:'all'})">
        <option value="">All sites</option>
        ${sites.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join("")}
      </select>
      <div class="map-zoom-controls">
        <button class="btn small" onclick="mapZoom(1.25)" title="Zoom in">+</button>
        <button class="btn small" onclick="mapZoom(0.8)" title="Zoom out">&minus;</button>
        <button class="btn small" onclick="mapResetView()">Reset view</button>
      </div>
      <button class="btn small" onclick="printMap()">Print map</button>
      <span class="note" id="map_highlightNote" style="display:none;">Showing a path &middot; <a class="link" onclick="clearMapHighlight()">Clear</a></span>
      ${isAdmin() ? `<span class="note">Drag a device to place it -- positions save automatically.</span>` : ""}
    </div>
    <div class="print-meta">LinkLedger &mdash; printed ${esc(new Date().toLocaleString())}</div>
    <div class="map-canvas-wrap" id="mapCanvasWrap">
      <svg id="mapSvg" width="100%" height="640"></svg>
      <div class="map-popover" id="mapPopover" style="display:none;"></div>
    </div>
    <div class="map-legend">
      <span><span class="map-legend-dot" style="background:#22c55e"></span>Connected</span>
      <span><span class="map-legend-dot" style="background:#f59e0b"></span>Patch panel: one side only</span>
      <span><span class="map-legend-dot" style="background:#cbd5e1"></span>Not connected</span>
      <span class="note">Solid = cable &middot; Dashed = wireless/virtual link</span>
      <span class="note">Dashed outline = normally-hidden device shown because it's on a highlighted path</span>
    </div>
  </div>`;
}

async function renderMapView() {
  const root = document.getElementById("mapView");
  root.innerHTML = `<div class="card"><span class="note">Loading map...</span></div>`;
  let data;
  try {
    data = await api("/api/topology");
  } catch (e) {
    root.innerHTML = `<div class="card"><div class="error-msg">${esc(e.message)}</div></div>`;
    return;
  }
  MAP_DATA = data;
  MAP_PORT_BY_ID = mapIndexPorts(data);
  root.innerHTML = mapShellHTML();
  mapAttachHandlers(document.getElementById("mapSvg"));
  let fit = "all";
  if (PENDING_MAP_HIGHLIGHT) {
    MAP_HIGHLIGHT = computeHighlightFromPath(PENDING_MAP_HIGHLIGHT);
    PENDING_MAP_HIGHLIGHT = null;
    fit = "highlight";
  } else {
    MAP_HIGHLIGHT = null;
  }
  drawMap({ fit });
  updateMapHighlightNote();
}

// ---------------------------------------------------------------------------
// Modal plumbing
// ---------------------------------------------------------------------------
function closeModal() { document.getElementById("modalRoot").innerHTML = ""; }
function renderModal(html, extraClass) {
  document.getElementById("modalRoot").innerHTML =
    `<div class="modal-backdrop" onclick="if(event.target===this) closeModal()"><div class="modal${extraClass ? " " + extraClass : ""}">${html}</div></div>`;
}

// --- Add/edit device ---
async function openDeviceModal(deviceId) {
  const [d, roleSettings, sites] = await Promise.all([
    deviceId ? api(`/api/devices/${deviceId}`) : Promise.resolve({ name: "", role: "", model: "", site: "", notes: "", poe_required: false, show_on_map: true }),
    api("/api/settings/roles"),
    api("/api/sites"),
  ]);
  // Role dropdown options come from Settings -> Device roles. If the
  // device's current role isn't in that enabled set, keep it selectable
  // so saving the modal doesn't blank it out.
  const roleNames = roleSettings.enabled.slice();
  if (d.role && !roleNames.includes(d.role)) roleNames.push(d.role);
  // Same idea for site.
  const siteNames = sites.map(s => s.name);
  if (d.site && !siteNames.includes(d.site)) siteNames.push(d.site);
  renderModal(`
    <h3>${deviceId ? "Edit device" : "Add device"}</h3>
    <div id="deviceModalError"></div>
    <div class="field"><label>Name</label><input type="text" id="f_name" value="${esc(d.name)}"></div>
    <div class="field"><label>Role</label>
      <select id="f_role">
        <option value="" ${d.role === "" ? "selected" : ""}>(none)</option>
        ${roleNames.map(r => `<option value="${esc(r)}" ${d.role === r ? "selected" : ""}>${esc(r)}</option>`).join("")}
      </select>
    </div>
    <div class="field"><label>Model</label><input type="text" id="f_model" value="${esc(d.model)}"></div>
    <div class="field"><label>Site ${siteNames.length === 0 ? `<span class="note">(add some in <a class="link" onclick="window.open('/static/settings.html', '_blank')">Settings</a>)</span>` : ""}</label>
      <select id="f_site">
        <option value="" ${d.site === "" ? "selected" : ""}>(none)</option>
        ${siteNames.map(s => `<option value="${esc(s)}" ${d.site === s ? "selected" : ""}>${esc(s)}</option>`).join("")}
      </select>
    </div>
    <div class="field"><label>Notes</label><input type="text" id="f_notes" value="${esc(d.notes)}"></div>
    <div class="field checkbox-field">
      <label><input type="checkbox" id="f_poe" ${d.poe_required ? "checked" : ""}> Requires PoE</label>
    </div>
    ${deviceId ? `<div class="field checkbox-field">
      <label><input type="checkbox" id="f_showOnMap" ${d.show_on_map ? "checked" : ""}> Show on map</label>
      <span class="note">Off by default for Client, Appliance, and Server devices, to keep the Map tab from getting crowded.</span>
    </div>` : ""}
    ${deviceId && d.ports && d.ports.length && !VIRTUAL_SWITCH_ROLES.includes(d.role) ? `<div class="field">
      <span class="note">${d.port_layout_mode === "custom"
        ? "This device uses a custom free-form port layout on the Map tab."
        : "This device's ports are laid out automatically on the Map tab."}
      <a class="link" onclick="closeModal(); openPortLayoutModal(${deviceId})">Edit port layout</a></span>
    </div>` : ""}
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn primary" onclick="submitDevice(${deviceId || "null"})">${deviceId ? "Save" : "Add"}</button>
    </div>`);
}

async function submitDevice(deviceId) {
  const body = {
    name: document.getElementById("f_name").value,
    role: document.getElementById("f_role").value,
    model: document.getElementById("f_model").value,
    site: document.getElementById("f_site").value,
    notes: document.getElementById("f_notes").value,
    poe_required: document.getElementById("f_poe").checked,
  };
  const somEl = document.getElementById("f_showOnMap");
  if (somEl) body.show_on_map = somEl.checked;
  try {
    if (deviceId) {
      await api(`/api/devices/${deviceId}`, { method: "PUT", body: JSON.stringify(body) });
    } else {
      const created = await api("/api/devices", { method: "POST", body: JSON.stringify(body) });
      deviceId = created.id;
    }
    closeModal();
    showToast("Device saved");
    viewDevice(deviceId);
  } catch (e) {
    document.getElementById("deviceModalError").innerHTML = `<div class="error-msg">${esc(e.message)}</div>`;
  }
}

async function confirmDeleteDevice(id, name) {
  if (!confirm(`Delete "${name}"? This also deletes its ports and any cables connected to them.`)) return;
  try {
    await api(`/api/devices/${id}`, { method: "DELETE" });
    showToast("Device deleted");
    // Drop the Device tab so it hides again instead of pointing at a
    // device that's gone.
    if (lastViewedDeviceId === id) lastViewedDeviceId = null;
    await navigateTo({ tab: "browse" });
  } catch (e) { showToast(e.message, true); }
}

// --- Edit port layout -- a free-form per-port grid, maintained at the
// device level and used by the Map tab instead of the sequential Ports
// per row wrap once a device is switched into 'custom' mode (see
// mapCustomGridLayout/mapAutoGridLayout in the Map section above). The
// grid's own row/col numbers are purely a canvas-sizing/editing
// convenience here -- only each position's own row/col is ever saved.
// ---------------------------------------------------------------------------
const PL_CELL = 44;
const PL_MAX_GRID = 40;
let PORT_LAYOUT_EDITOR = null;  // {deviceId, mode, cols, rows, positions:[{key,ports,row,col}]}

function plChipLabel(pos) {
  if (pos.ports.length > 1) {
    // A patch-panel front/rear pair -- "12 (rear)"/"12 (front)" -> "12".
    const m = pos.ports[0].name.match(/^(\d+)/);
    return m ? m[1] : pos.ports.map(p => p.name).join(" / ");
  }
  return pos.ports[0].name;
}

async function openPortLayoutModal(deviceId) {
  const d = await api(`/api/devices/${deviceId}`);
  const groups = mapDevicePositions(d);
  const layout = d.port_layout_mode === "custom"
    ? mapCustomGridLayout(groups, 16)
    : mapAutoGridLayout(groups, d.ports_per_row);
  PORT_LAYOUT_EDITOR = {
    deviceId,
    deviceName: d.name,
    mode: d.port_layout_mode,
    cols: Math.max(layout.cols, 8),
    rows: Math.max(layout.rows, 6),
    positions: layout.positions.map(p => ({ key: p.key, ports: p.ports, row: p.row, col: p.col })),
  };
  renderModal(`
    <h3>Edit port layout &mdash; ${esc(d.name)}</h3>
    <p class="note">Drag a port (or a patch panel's paired front/rear jack) into any cell. Leave cells empty to
      show a gap in the diagram -- e.g. for a switch's extra ports grouped off to one side.</p>
    <div class="pl-toolbar">
      <button class="btn small" onclick="plAddRow()">+ Row</button>
      <button class="btn small" onclick="plAddCol()">+ Column</button>
      <button class="btn small" onclick="plCompact()">Shrink to fit</button>
      <div class="spacer"></div>
      <button class="btn small" onclick="resetPortLayoutToAuto()" ${d.port_layout_mode === "custom" ? "" : "disabled"}>Reset to automatic layout</button>
    </div>
    <div id="plCanvasWrap" class="pl-canvas-wrap">
      <div id="plCanvas" class="pl-canvas" ondragover="event.preventDefault()" ondrop="plDrop(event)"></div>
    </div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn primary" onclick="savePortLayout()">Save</button>
    </div>`, "modal-wide");
  renderPortLayoutGrid();
}

function renderPortLayoutGrid() {
  const ed = PORT_LAYOUT_EDITOR;
  const canvas = document.getElementById("plCanvas");
  if (!ed || !canvas) return;
  canvas.style.width = `${ed.cols * PL_CELL}px`;
  canvas.style.height = `${ed.rows * PL_CELL}px`;
  canvas.style.backgroundSize = `${PL_CELL}px ${PL_CELL}px`;
  const inset = 3, size = PL_CELL - inset * 2;
  canvas.innerHTML = ed.positions.map(pos => `
    <div class="pl-chip" draggable="true" title="${esc(pos.ports.map(p => p.name).join(" / "))}"
         style="left:${pos.col * PL_CELL + inset}px; top:${pos.row * PL_CELL + inset}px; width:${size}px; height:${size}px;"
         ondragstart="plDragStart(event, '${esc(String(pos.key))}')">${esc(plChipLabel(pos))}</div>
  `).join("");
}

function plDragStart(ev, key) {
  ev.dataTransfer.setData("text/plain", key);
  ev.dataTransfer.effectAllowed = "move";
}

function plDrop(ev) {
  ev.preventDefault();
  const key = ev.dataTransfer.getData("text/plain");
  const ed = PORT_LAYOUT_EDITOR;
  if (!ed) return;
  const canvas = document.getElementById("plCanvas");
  const rect = canvas.getBoundingClientRect();
  let col = Math.floor((ev.clientX - rect.left) / PL_CELL);
  let row = Math.floor((ev.clientY - rect.top) / PL_CELL);
  col = Math.max(0, Math.min(col, ed.cols - 1));
  row = Math.max(0, Math.min(row, ed.rows - 1));
  const moving = ed.positions.find(p => String(p.key) === key);
  if (!moving || (moving.row === row && moving.col === col)) return;
  // Swap with whatever's already in that cell (if anything), instead of
  // ever allowing two positions to overlap.
  const target = ed.positions.find(p => p !== moving && p.row === row && p.col === col);
  if (target) { target.row = moving.row; target.col = moving.col; }
  moving.row = row; moving.col = col;
  renderPortLayoutGrid();
}

function plAddRow() {
  PORT_LAYOUT_EDITOR.rows = Math.min(PORT_LAYOUT_EDITOR.rows + 1, PL_MAX_GRID);
  renderPortLayoutGrid();
}

function plAddCol() {
  PORT_LAYOUT_EDITOR.cols = Math.min(PORT_LAYOUT_EDITOR.cols + 1, PL_MAX_GRID);
  renderPortLayoutGrid();
}

function plCompact() {
  const ed = PORT_LAYOUT_EDITOR;
  const maxRow = ed.positions.reduce((m, p) => Math.max(m, p.row), 0);
  const maxCol = ed.positions.reduce((m, p) => Math.max(m, p.col), 0);
  ed.rows = Math.max(maxRow + 1, 1);
  ed.cols = Math.max(maxCol + 1, 1);
  renderPortLayoutGrid();
}

async function savePortLayout() {
  const ed = PORT_LAYOUT_EDITOR;
  const positions = [];
  ed.positions.forEach(pos => pos.ports.forEach(p => positions.push({ port_id: p.id, grid_row: pos.row, grid_col: pos.col })));
  try {
    await api(`/api/devices/${ed.deviceId}/port-grid`, { method: "PUT", body: JSON.stringify({ positions }) });
    if (ed.mode !== "custom") {
      await api(`/api/devices/${ed.deviceId}/port-layout-mode`, { method: "PUT", body: JSON.stringify({ mode: "custom" }) });
    }
    closeModal();
    showToast("Port layout saved");
    refreshCurrentDevice();
  } catch (e) {
    showToast(e.message, true);
  }
}

async function resetPortLayoutToAuto() {
  const ed = PORT_LAYOUT_EDITOR;
  if (!ed || ed.mode !== "custom") return;
  if (!confirm("Switch this device back to the automatic layout on the Map tab? "
    + "Your custom positions stay saved, so you can switch back to a custom layout later.")) return;
  try {
    await api(`/api/devices/${ed.deviceId}/port-layout-mode`, { method: "PUT", body: JSON.stringify({ mode: "auto" }) });
    closeModal();
    showToast("Switched to automatic layout");
    refreshCurrentDevice();
  } catch (e) {
    showToast(e.message, true);
  }
}

// --- Add ports ---
async function openPortModal(deviceId, deviceRole) {
  const speedOptions = await getSpeedOptions("");
  renderModal(`
    <h3>Add port(s)</h3>
    <div id="portModalError"></div>
    <div class="field">
      <label>Name, or a range like <code>Port[1-8]</code></label>
      <input type="text" id="f_portname" placeholder="e.g. eth0, or Port[1-16]">
    </div>
    <div class="field"><label>Speed (optional, applies to all)</label>
      <select id="f_portspeed">
        ${speedOptions.map(s => `<option value="${s}">${s || "(not set)"}</option>`).join("")}
      </select>
    </div>
    ${VLAN_POE_CAPABLE_ROLES.includes(deviceRole) ? `
    <div class="field checkbox-field">
      <label><input type="checkbox" id="f_portpoe"> Supplies PoE (applies to all)</label>
    </div>` : ""}
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn primary" onclick="submitPorts(${deviceId})">Add</button>
    </div>`);
}

function expandPortPattern(pattern) {
  const m = pattern.trim().match(/^(.*)\[(\d+)-(\d+)\]$/);
  if (!m) return [pattern.trim()];
  const [, prefix, from, to] = m;
  const names = [];
  for (let i = Number(from); i <= Number(to); i++) names.push(`${prefix}${i}`);
  return names;
}

async function submitPorts(deviceId) {
  const raw = document.getElementById("f_portname").value;
  if (!raw.trim()) return;
  const names = expandPortPattern(raw);
  const speed = document.getElementById("f_portspeed").value;
  const poeField = document.getElementById("f_portpoe");
  const poe_supply = poeField ? poeField.checked : false;
  try {
    if (names.length === 1) {
      await api(`/api/devices/${deviceId}/ports`, { method: "POST", body: JSON.stringify({ name: names[0], speed, poe_supply }) });
    } else {
      await api(`/api/devices/${deviceId}/ports/bulk`, { method: "POST", body: JSON.stringify({ names, speed, poe_supply }) });
    }
    closeModal();
    showToast(`Added ${names.length} port(s)`);
    viewDevice(deviceId);
  } catch (e) {
    document.getElementById("portModalError").innerHTML = `<div class="error-msg">${esc(e.message)}</div>`;
  }
}

function openPatchPanelModal(deviceId, nextSuggestedStart) {
  renderModal(`
    <h3>Add paired patch panel ports</h3>
    <p class="note">Creates front/rear port pairs, pre-linked so traces pass straight through — e.g. 24 pairs starting at 1 for a standard panel. Adding more pairs to a panel that already has some? Set "Starting at" to the first new number — e.g. count 1, starting at 20 adds just a "20 (front)"/"20 (rear)" pair without touching your existing ports.</p>
    <div id="panelModalError"></div>
    <div class="field"><label>Number of pairs to add</label><input type="number" id="f_count" value="24" min="1" max="96"></div>
    <div class="field"><label>Starting at</label><input type="number" id="f_start" value="${nextSuggestedStart || 1}" min="1"></div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn primary" onclick="submitPatchPanel(${deviceId})">Add</button>
    </div>`);
}

async function submitPatchPanel(deviceId) {
  const count = Number(document.getElementById("f_count").value);
  const start = Number(document.getElementById("f_start").value) || 1;
  try {
    await api(`/api/devices/${deviceId}/patch-panel`, { method: "POST", body: JSON.stringify({ count, start }) });
    closeModal();
    showToast(`Added ${count} paired port(s) starting at ${start}`);
    viewDevice(deviceId);
  } catch (e) {
    document.getElementById("panelModalError").innerHTML = `<div class="error-msg">${esc(e.message)}</div>`;
  }
}

// The port speed picker's options come from Settings -> Interface speeds.
// Always includes "" (not set) first, and the port's own current value
// even if it's since been hidden from the picker.
async function getSpeedOptions(currentValue) {
  const settings = await api("/api/settings/speeds");
  const opts = settings.enabled.slice();
  if (currentValue && !opts.includes(currentValue)) opts.push(currentValue);
  return ["", ...opts];
}

async function openEditPortModal(port) {
  const speedOptions = await getSpeedOptions(port.speed);
  renderModal(`
    <h3>Edit port</h3>
    <div id="editPortError"></div>
    <div class="field"><label>Name</label><input type="text" id="ep_name" value="${esc(port.name)}"></div>
    <div class="field"><label>Speed</label>
      <select id="ep_speed">
        ${speedOptions.map(s => `<option value="${s}" ${port.speed === s ? "selected" : ""}>${s || "(not set)"}</option>`).join("")}
      </select>
    </div>
    ${VLAN_POE_CAPABLE_ROLES.includes(port.deviceRole) || port.virtual_switch_id ? `
    <div class="field"><label>VLAN(s)</label>
      <input type="text" id="ep_vlans" value="${esc(port.vlans || "")}" placeholder="e.g. 10 or 10, 20 (trunk)">
    </div>` : ""}
    ${VLAN_POE_CAPABLE_ROLES.includes(port.deviceRole) ? `
    <div class="field checkbox-field">
      <label><input type="checkbox" id="ep_poe" ${port.poe_supply ? "checked" : ""}> Supplies PoE</label>
    </div>` : ""}
    <div class="field"><label>MAC address</label>
      <input type="text" id="ep_mac" value="${esc(port.mac_address || "")}" placeholder="e.g. AA:BB:CC:DD:EE:FF">
      <span class="note">Layer 2 only &mdash; LinkLedger doesn't track IP addresses. Used to match this port against pfSense discovery data, if set up (see the Discovery tab).</span>
    </div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn primary" onclick="submitEditPort(${port.id})">Save</button>
    </div>`);
}

async function submitEditPort(portId) {
  const body = {
    name: document.getElementById("ep_name").value,
    speed: document.getElementById("ep_speed").value,
    mac_address: document.getElementById("ep_mac").value,
  };
  const vlansField = document.getElementById("ep_vlans");
  if (vlansField) body.vlans = vlansField.value;
  const poeField = document.getElementById("ep_poe");
  if (poeField) body.poe_supply = poeField.checked;
  try {
    await api(`/api/ports/${portId}`, { method: "PUT", body: JSON.stringify(body) });
    closeModal();
    showToast("Port updated");
    refreshCurrentDevice();
  } catch (e) {
    document.getElementById("editPortError").innerHTML = `<div class="error-msg">${esc(e.message)}</div>`;
  }
}

// ---------------------------------------------------------------------------
// Reports -- read-only data-quality checks (see crud.data_quality_report
// on the backend).
// ---------------------------------------------------------------------------

// Each report is a plain <details>, collapsed by default. Title and
// count sit in the <summary>; the note and body only render once expanded.
function reportSection(key, title, note, count, bodyHtml) {
  return `
    <details class="card report-card" data-report="${esc(key)}">
      <summary class="device-header">
        <strong>${esc(title)}</strong>
        <span class="tag" style="background:${count ? "#fef2f2" : "#dcfce7"}; color:${count ? "#b91c1c" : "#15803d"};">${count}</span>
      </summary>
      <p class="note" style="margin:10px 0 10px;">${note}</p>
      ${count === 0 ? `<div class="empty-state">Nothing to report here.</div>` : bodyHtml}
    </details>`;
}

function reportPortsTable(ports) {
  return `<table><tr><th>Device</th><th>Port</th></tr>
    ${ports.map(p => `<tr>
      <td><a class="link" href="${deviceHref(p.device_id)}" onclick="deviceLinkClick(event, ${p.device_id})">${esc(p.device_name)}</a> ${roleBadge(p.device_role)}</td>
      <td class="port-name">${esc(cleanPortLabel(p.name))}</td>
    </tr>`).join("")}
  </table>`;
}

function reportSpeedMismatches(rows) {
  return `<table><tr><th>End device</th><th>Port</th><th></th><th>Connects to (via patch panels, if any)</th><th>Port</th></tr>
    ${rows.map(r => `<tr>
      <td><a class="link" href="${deviceHref(r.device_id)}" onclick="deviceLinkClick(event, ${r.device_id})">${esc(r.device_name)}</a> ${roleBadge(r.device_role)}</td>
      <td class="port-name">${esc(cleanPortLabel(r.port_name))} ${speedTag(r.port_speed)}</td>
      <td class="note">&rarr;</td>
      <td><a class="link" href="${deviceHref(r.target_device_id)}" onclick="deviceLinkClick(event, ${r.target_device_id})">${esc(r.target_device_name)}</a> ${roleBadge(r.target_device_role)}</td>
      <td class="port-name">${esc(cleanPortLabel(r.target_port_name))} ${speedTag(r.target_port_speed)}</td>
    </tr>`).join("")}
  </table>`;
}

function reportUnmanagedSites(groups) {
  return groups.map(g => `
    <div style="margin-bottom:14px;">
      <div>&ldquo;${esc(g.site)}&rdquo; <span class="note">&mdash; ${g.devices.length} device${g.devices.length === 1 ? "" : "s"}</span></div>
      <div class="device-grid" style="margin-top:6px;">${g.devices.map(deviceChip).join("")}</div>
    </div>`).join("");
}

// One entry per report key (see crud.REPORT_DEFS on the backend, which
// supplies the title and display order). This map supplies the note text
// and how to turn that key's slice of /api/reports into a count + body.
function reportRenderers(r, devGrid) {
  return {
    missing_site: () => ({
      note: "Devices with no Site value set.",
      count: r.missing_site.length, body: devGrid(r.missing_site),
    }),
    missing_model: () => ({
      note: "Devices with no Model value set.",
      count: r.missing_model.length, body: devGrid(r.missing_model),
    }),
    missing_role: () => ({
      note: "Devices with no Role set &mdash; role drives VLAN/PoE options, path finding, and more, so these are worth a look.",
      count: r.missing_role.length, body: devGrid(r.missing_role),
    }),
    unmanaged_site_values: () => ({
      note: "Devices whose Site is set to a value that isn't in Settings &rarr; Sites &mdash; could be a typo, data from before the list existed, or a site that's since been renamed/removed there.",
      count: r.unmanaged_site_values.reduce((n, g) => n + g.devices.length, 0),
      body: reportUnmanagedSites(r.unmanaged_site_values),
    }),
    missing_speed: () => ({
      note: "Ports with no Speed set (excludes patch panel pass-through ports and wireless/virtual member links, which don't have a speed of their own).",
      count: r.missing_speed.length, body: reportPortsTable(r.missing_speed),
    }),
    unused_ports: () => ({
      note: "Ports with no cable, no pairing, and no wireless/virtual link &mdash; just sitting there unconnected.",
      count: r.unused_ports.length, body: reportPortsTable(r.unused_ports),
    }),
    no_uplinks: () => ({
      note: "These have no way to actually reach the rest of the network yet &mdash; add at least one uplink from the device's own page.",
      count: r.no_uplinks.length, body: devGrid(r.no_uplinks),
    }),
    no_ports: () => ({
      note: "Devices added but never given any ports yet.",
      count: r.no_ports.length, body: devGrid(r.no_ports),
    }),
    poe_unmet: () => ({
      note: "Devices flagged Requires PoE where nothing along any port's trace is tagged as supplying it.",
      count: r.poe_unmet.length, body: devGrid(r.poe_unmet),
    }),
    speed_mismatches: () => ({
      note: "A device's port is rated faster than the switch/router port it ultimately connects to (patch panels in between are looked through) &mdash; it can never actually run faster than that.",
      count: r.speed_mismatches.length, body: reportSpeedMismatches(r.speed_mismatches),
    }),
  };
}

async function renderReportsView() {
  const box = document.getElementById("reportsView");
  box.innerHTML = `<div class="card"><div class="empty-state">Loading…</div></div>`;
  let r, settings;
  try {
    [r, settings] = await Promise.all([api("/api/reports"), api("/api/settings/reports")]);
  } catch (e) {
    box.innerHTML = `<div class="card"><div class="error-msg">${esc(e.message)}</div></div>`;
    return;
  }

  const devGrid = devices => `<div class="device-grid">${devices.map(deviceChip).join("")}</div>`;
  const renderers = reportRenderers(r, devGrid);
  const enabled = new Set(settings.enabled);

  const sections = settings.all
    .filter(def => enabled.has(def.key))
    .map(def => {
      const { note, count, body } = renderers[def.key]();
      return reportSection(def.key, def.title, note, count, body);
    });

  box.innerHTML = sections.length ? sections.join("") : `
    <div class="card"><div class="empty-state">No reports are shown &mdash; pick some from Settings &rarr; Reports shown.</div></div>`;
}

// ---------------------------------------------------------------------------
// Discovery -- pending devices found via pfSense ARP/DHCP sync (see
// Settings -> pfSense device discovery). Every /api/discovery* and
// /api/settings/pfsense* endpoint is admin-only, same as this tab.
// ---------------------------------------------------------------------------
let discoveryInstanceFilter = "";

async function renderDiscoveryView() {
  const box = document.getElementById("discoveryView");
  box.innerHTML = `<div class="card"><div class="empty-state">Loading…</div></div>`;
  let rows, instances;
  try {
    [rows, instances] = await Promise.all([
      api(`/api/discovery${discoveryInstanceFilter ? `?instance_id=${discoveryInstanceFilter}` : ""}`),
      api("/api/settings/pfsense"),
    ]);
  } catch (e) {
    box.innerHTML = `<div class="card"><div class="error-msg">${esc(e.message)}</div></div>`;
    return;
  }
  const instanceOptions = instances.map(i =>
    `<option value="${i.id}" ${String(i.id) === String(discoveryInstanceFilter) ? "selected" : ""}>${esc(i.name)}</option>`
  ).join("");
  box.innerHTML = `
    <div class="card">
      <div class="device-header">
        <strong>Discovered devices</strong>
        <span class="note">${rows.length} pending</span>
        <div class="spacer"></div>
        ${instances.length > 1 ? `
        <select id="discoveryInstanceFilter" style="width:auto;" onchange="onDiscoveryInstanceFilterChange(this.value)">
          <option value="">All instances</option>
          ${instanceOptions}
        </select>` : ""}
        <button class="btn small" onclick="syncAllPfsenseNow()">Sync now</button>
      </div>
      ${instances.length === 0 ? `
        <div class="empty-state">No pfSense instances are set up yet. Add one in <a class="link" onclick="window.open('/static/settings.html', '_blank')">Settings</a> to start finding new devices automatically.</div>
      ` : rows.length === 0 ? `
        <div class="empty-state">No pending devices right now. New MACs seen in pfSense's ARP/DHCP data on an enabled interface show up here.</div>
      ` : `
        <table><tr><th>MAC address</th><th>DNS name</th><th>IP</th><th>Interface</th><th>Source</th><th>Last seen</th><th></th></tr>
          ${rows.map(discoveryRow).join("")}
        </table>
      `}
    </div>`;
}

function discoveryRow(r) {
  return `<tr data-discovery-row="${r.id}">
    <td style="font-family:monospace;">${esc(r.mac_address)}</td>
    <td>${esc(r.dns_name || "—")}</td>
    <td>${esc(r.ip_address || "—")}</td>
    <td>${esc(r.interface || "—")}</td>
    <td>${esc(r.instance_name)}${r.site ? ` <span class="note">(${esc(r.site)})</span>` : ""}</td>
    <td>${esc(r.last_seen)}</td>
    <td class="row-actions">
      <button class="btn small" onclick="openImportDiscoveredModal(${r.id})">Create device</button>
      <button class="btn small" onclick="openLinkDiscoveredModal(${r.id})">Link to port</button>
      <button class="btn small danger" onclick="ignoreDiscovered(${r.id})">Ignore</button>
    </td>
  </tr>`;
}

function onDiscoveryInstanceFilterChange(value) {
  discoveryInstanceFilter = value;
  renderDiscoveryView();
}

async function syncAllPfsenseNow() {
  try {
    await api("/api/discovery/sync", { method: "POST" });
    showToast("Synced");
    renderDiscoveryView();
  } catch (e) { showToast(e.message, true); }
}

async function ignoreDiscovered(id) {
  if (!confirm("Ignore this device? It won't show up again unless a future sync sees new activity for it.")) return;
  try {
    await api(`/api/discovery/${id}/ignore`, { method: "POST" });
    showToast("Ignored");
    renderDiscoveryView();
  } catch (e) { showToast(e.message, true); }
}

// --- Create device from a discovered MAC ---
async function openImportDiscoveredModal(discoveredId) {
  const [roleSettings, sites] = await Promise.all([api("/api/settings/roles"), api("/api/sites")]);
  const siteNames = sites.map(s => s.name);
  renderModal(`
    <h3>Create device from discovered MAC</h3>
    <div id="importDiscoveredError"></div>
    <div class="field"><label>Name</label><input type="text" id="imp_name" placeholder="Device name"></div>
    <div class="field"><label>Role</label>
      <select id="imp_role">
        <option value="">(none)</option>
        ${roleSettings.enabled.map(r => `<option value="${esc(r)}">${esc(r)}</option>`).join("")}
      </select>
    </div>
    <div class="field"><label>Model</label><input type="text" id="imp_model"></div>
    <div class="field"><label>Site ${siteNames.length === 0 ? `<span class="note">(add some in <a class="link" onclick="window.open('/static/settings.html', '_blank')">Settings</a>)</span>` : ""}</label>
      <select id="imp_site">
        <option value="">(use the pfSense instance's site, if it has one)</option>
        ${siteNames.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join("")}
      </select>
    </div>
    <div class="field"><label>Notes</label><input type="text" id="imp_notes"></div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn primary" onclick="submitImportDiscovered(${discoveredId})">Create device</button>
    </div>`);
}

async function submitImportDiscovered(discoveredId) {
  const name = document.getElementById("imp_name").value.trim();
  if (!name) {
    document.getElementById("importDiscoveredError").innerHTML = `<div class="error-msg">Name is required.</div>`;
    return;
  }
  const siteVal = document.getElementById("imp_site").value;
  const body = {
    name,
    role: document.getElementById("imp_role").value,
    model: document.getElementById("imp_model").value,
    notes: document.getElementById("imp_notes").value,
  };
  if (siteVal) body.site = siteVal;  // omitted -> crud.import_discovered falls back to the instance's own site
  try {
    const device = await api(`/api/discovery/${discoveredId}/import`, { method: "POST", body: JSON.stringify(body) });
    closeModal();
    showToast("Device created");
    viewDevice(device.id);
  } catch (e) {
    document.getElementById("importDiscoveredError").innerHTML = `<div class="error-msg">${esc(e.message)}</div>`;
  }
}

// --- Link a discovered MAC to an existing port ---
async function openLinkDiscoveredModal(discoveredId) {
  renderModal(`
    <h3>Link discovered MAC to an existing port</h3>
    <div id="linkDiscoveredError"></div>
    <div class="field autocomplete" style="margin-bottom:0;">
      <label>Device</label>
      <input type="text" id="dl_deviceSearch" placeholder="Search a device..." autocomplete="off"
             oninput="onLinkDiscoveredDeviceSearch()" onfocus="onLinkDiscoveredDeviceSearch()">
      <input type="hidden" id="dl_deviceId">
      <div class="results" id="dl_deviceResults"></div>
    </div>
    <div class="field"><label>Port</label><select id="dl_port"><option value="">Select device first...</option></select></div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn primary" onclick="submitLinkDiscovered(${discoveredId})">Link</button>
    </div>`);
}

async function onLinkDiscoveredDeviceSearch() {
  const q = document.getElementById("dl_deviceSearch").value.trim();
  const box = document.getElementById("dl_deviceResults");
  if (!q) { box.classList.remove("show"); return; }
  const matches = await api(`/api/devices?q=${encodeURIComponent(q)}`);
  box.innerHTML = matches.length
    ? matches.map(d => `<div class="result-item" onclick='selectLinkDiscoveredDevice(${d.id}, ${JSON.stringify(d.name).replace(/'/g, "&#39;")})'><span>${escBreakable(d.name)}</span>${roleBadge(d.role)}</div>`).join("")
    : `<div class="result-item">No matches</div>`;
  box.classList.add("show");
}

async function selectLinkDiscoveredDevice(id, name) {
  document.getElementById("dl_deviceId").value = id;
  const inp = document.getElementById("dl_deviceSearch");
  inp.value = name;
  inp.title = name;
  document.getElementById("dl_deviceResults").classList.remove("show");
  const d = await api(`/api/devices/${id}`);
  const sel = document.getElementById("dl_port");
  sel.innerHTML = d.ports.length
    ? d.ports.map(p => `<option value="${p.id}">${esc(p.name)}${p.mac_address ? ` (already has a MAC)` : ""}</option>`).join("")
    : `<option value="" disabled>No ports on this device</option>`;
}

async function submitLinkDiscovered(discoveredId) {
  const portId = document.getElementById("dl_port").value;
  const errBox = document.getElementById("linkDiscoveredError");
  if (!portId) {
    errBox.innerHTML = `<div class="error-msg">Pick a device and port first.</div>`;
    return;
  }
  try {
    await api(`/api/discovery/${discoveredId}/link`, { method: "POST", body: JSON.stringify({ port_id: Number(portId) }) });
    closeModal();
    showToast("Linked");
    renderDiscoveryView();
  } catch (e) {
    errBox.innerHTML = `<div class="error-msg">${esc(e.message)}</div>`;
  }
}

async function deletePort(portId) {
  if (!confirm("Delete this port? Any cable using it will be removed too.")) return;
  try {
    await api(`/api/ports/${portId}`, { method: "DELETE" });
    showToast("Port deleted");
    refreshCurrentDevice();
  } catch (e) { showToast(e.message, true); }
}

async function disconnectPort(portId) {
  try {
    await api(`/api/ports/${portId}/cable`, { method: "DELETE" });
    showToast("Disconnected");
    refreshCurrentDevice();
  } catch (e) { showToast(e.message, true); }
}

// --- Connect two ports ---
let connectState = { sourcePortId: null, targetDeviceId: null };

function connectDeviceField(which, label) {
  return `
    <div class="field autocomplete" style="margin-bottom:0;">
      <label>${label}</label>
      <input type="text" id="c_${which}Search" placeholder="Search a device..." autocomplete="off"
             oninput="onConnectDeviceSearch('${which}')" onfocus="onConnectDeviceSearch('${which}')">
      <input type="hidden" id="c_${which}Device">
      <div class="results" id="c_${which}Results"></div>
    </div>`;
}

async function openConnectModal(sourcePortId) {
  connectState = { sourcePortId, targetDeviceId: null };
  const devices = await api("/api/devices");
  const vsDevices = devices.filter(d => VIRTUAL_SWITCH_ROLES.includes(d.role));
  renderModal(`
    <h3>Connect port</h3>
    <div id="connectModalError"></div>
    ${sourcePortId ? `
    <div class="field checkbox-field" style="margin-bottom:12px;">
      <label><input type="radio" name="c_mode" value="cable" checked onchange="onConnectModeChange()"> Cable to a device/port</label><br>
      <label><input type="radio" name="c_mode" value="virtual" onchange="onConnectModeChange()"> Wireless / virtual link to an AP Group or Virtual Switch</label>
    </div>` : ""}
    <div id="c_cableFields">
      ${sourcePortId ? "" : `
        ${connectDeviceField("source", "From device")}
        <div class="field"><label>From port</label><select id="c_sourcePort" onchange="onConnectPortSelectChange('source')"><option value="">Select device first...</option></select></div>
        <div id="c_sourceNewPort"></div>
      `}
      ${connectDeviceField("target", "To device")}
      <div class="field"><label>To port</label><select id="c_targetPort" onchange="onConnectPortSelectChange('target')"><option value="">Select device first...</option></select></div>
      <div id="c_targetNewPort"></div>
    </div>
    <div id="c_virtualFields" style="display:none;">
      <div class="field"><label>AP Group / Virtual Switch</label>
        <select id="c_vsDevice">
          <option value="">Select...</option>
          ${vsDevices.map(d => `<option value="${d.id}">${esc(d.name)} (${esc(d.role)})</option>`).join("")}
        </select>
      </div>
      ${vsDevices.length ? "" : `<p class="note">No AP Group or Virtual Switch devices exist yet -- add one first.</p>`}
    </div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn primary" onclick="submitConnect()">Connect</button>
    </div>`);
}

function onConnectModeChange() {
  const checked = document.querySelector('input[name="c_mode"]:checked');
  const mode = checked ? checked.value : "cable";
  document.getElementById("c_cableFields").style.display = mode === "cable" ? "" : "none";
  document.getElementById("c_virtualFields").style.display = mode === "virtual" ? "" : "none";
}

async function onConnectDeviceSearch(which) {
  const q = document.getElementById(`c_${which}Search`).value.trim();
  const box = document.getElementById(`c_${which}Results`);
  if (!q) { box.classList.remove("show"); return; }
  const matches = await api(`/api/devices?q=${encodeURIComponent(q)}`);
  box.innerHTML = matches.length
    ? matches.map(d => `<div class="result-item" onclick='selectConnectDevice("${which}", ${d.id}, ${JSON.stringify(d.name).replace(/'/g, "&#39;")})'><span>${escBreakable(d.name)}</span>${roleBadge(d.role)}</div>`).join("")
    : `<div class="result-item">No matches</div>`;
  box.classList.add("show");
}

function selectConnectDevice(which, id, name) {
  document.getElementById(`c_${which}Device`).value = id;
  const inp = document.getElementById(`c_${which}Search`);
  inp.value = name;
  inp.title = name;
  document.getElementById(`c_${which}Results`).classList.remove("show");
  onConnectDeviceChange(which);
}

// Populates the From/To port select for whichever device was just
// picked. A port already in use is still selectable; its label shows
// what it's currently connected to.
async function onConnectDeviceChange(which) {
  const deviceId = document.getElementById(`c_${which}Device`).value;
  const sel = document.getElementById(`c_${which}Port`);
  const newPortBox = document.getElementById(`c_${which}NewPort`);
  if (newPortBox) newPortBox.innerHTML = "";
  if (!sel) return;
  if (!deviceId) { sel.innerHTML = `<option value="">Select device first...</option>`; return; }
  const d = await api(`/api/devices/${deviceId}`);
  const options = d.ports.map(p => {
    const inUse = p.trace && p.trace.length > 0;
    const connTo = inUse ? connectedToLabel(p.trace) : "";
    return `<option value="${p.id}" ${inUse ? `data-inuse="1" data-connto="${esc(connTo)}"` : ""}>${esc(p.name)}${inUse ? ` -- in use, connected to ${esc(connTo)}` : ""}</option>`;
  }).join("");
  sel.innerHTML = (d.ports.length ? options : `<option value="" disabled>No ports on this device</option>`)
    + `<option value="__new__">+ Add a new port...</option>`;
  if (!d.ports.length) {
    // Only "+ Add a new port..." is selectable; open its inline creator.
    sel.value = "__new__";
    onConnectPortSelectChange(which);
  }
}

function onConnectPortSelectChange(which) {
  const sel = document.getElementById(`c_${which}Port`);
  const box = document.getElementById(`c_${which}NewPort`);
  if (!sel || !box) return;
  if (sel.value === "__new__") {
    box.innerHTML = `
      <div class="field" style="display:flex; gap:8px; align-items:end; margin-top:-4px;">
        <div style="flex:1;"><label>New port name</label><input type="text" id="c_${which}NewPortName"></div>
        <button type="button" class="btn small" onclick="createConnectPort('${which}')">Create</button>
      </div>`;
  } else {
    box.innerHTML = "";
  }
}

async function createConnectPort(which) {
  const deviceId = document.getElementById(`c_${which}Device`).value;
  const nameField = document.getElementById(`c_${which}NewPortName`);
  const name = nameField ? nameField.value.trim() : "";
  if (!deviceId || !name) return;
  try {
    const port = await api(`/api/devices/${deviceId}/ports`, { method: "POST", body: JSON.stringify({ name }) });
    await onConnectDeviceChange(which);
    const sel = document.getElementById(`c_${which}Port`);
    sel.value = String(port.id);
    document.getElementById(`c_${which}NewPort`).innerHTML = "";
  } catch (e) {
    document.getElementById("connectModalError").innerHTML = `<div class="error-msg">${esc(e.message)}</div>`;
  }
}

async function submitConnect() {
  const modeEl = document.querySelector('input[name="c_mode"]:checked');
  const mode = modeEl ? modeEl.value : "cable";

  if (mode === "virtual") {
    const sourcePortId = connectState.sourcePortId;
    const vsId = Number(document.getElementById("c_vsDevice").value);
    if (!sourcePortId || !vsId) {
      document.getElementById("connectModalError").innerHTML = `<div class="error-msg">Pick an AP Group or Virtual Switch.</div>`;
      return;
    }
    try {
      await api(`/api/ports/${sourcePortId}/virtual-link`, { method: "POST", body: JSON.stringify({ virtual_switch_id: vsId }) });
      closeModal();
      showToast("Linked");
      refreshCurrentDevice();
    } catch (e) {
      document.getElementById("connectModalError").innerHTML = `<div class="error-msg">${esc(e.message)}</div>`;
    }
    return;
  }

  const sourceSel = document.getElementById("c_sourcePort");
  const targetSel = document.getElementById("c_targetPort");
  const sourcePortId = connectState.sourcePortId || Number(sourceSel?.value);
  const targetPortId = Number(targetSel.value);
  if (!sourcePortId || !targetPortId) {
    document.getElementById("connectModalError").innerHTML = `<div class="error-msg">Pick both a source and destination port.</div>`;
    return;
  }
  if (sourcePortId === targetPortId) {
    document.getElementById("connectModalError").innerHTML = `<div class="error-msg">Can't connect a port to itself.</div>`;
    return;
  }

  // Either end can be an already-in-use port (see onConnectDeviceChange) --
  // warn exactly what's about to be disconnected before overwriting it.
  const inUseWarnings = [];
  const sourceOpt = sourceSel?.selectedOptions[0];
  if (sourceOpt?.dataset.inuse) inUseWarnings.push(`the source port (currently connected to ${sourceOpt.dataset.connto})`);
  const targetOpt = targetSel.selectedOptions[0];
  if (targetOpt?.dataset.inuse) inUseWarnings.push(`the destination port (currently connected to ${targetOpt.dataset.connto})`);

  let overwrite = false;
  if (inUseWarnings.length) {
    overwrite = confirm(
      `This will disconnect ${inUseWarnings.join(" and ")} and replace it with this new connection. Continue?`
    );
    if (!overwrite) return;
  }

  try {
    await api("/api/cables", { method: "POST", body: JSON.stringify({ port_a_id: sourcePortId, port_b_id: targetPortId, overwrite }) });
    closeModal();
    showToast("Connected");
    refreshCurrentDevice();
  } catch (e) {
    document.getElementById("connectModalError").innerHTML = `<div class="error-msg">${esc(e.message)}</div>`;
  }
}

// --- Uplinks (AP Group / Virtual Switch) ---
async function openAddUplinkModal(vsId) {
  const devices = await api("/api/devices");
  renderModal(`
    <h3>Add uplink</h3>
    <p class="note">Pick a real port elsewhere in the topology that this virtual switch rides on top of -- e.g. an access point's wired port, or a hypervisor's physical NIC. That port keeps its own normal cable too.</p>
    <div id="uplinkModalError"></div>
    <div class="field"><label>Device</label><select id="u_device" onchange="onUplinkDeviceChange()">
      <option value="">Select a device...</option>
      ${devices.filter(d => d.id !== vsId).map(d => `<option value="${d.id}">${esc(d.name)}</option>`).join("")}
    </select></div>
    <div class="field"><label>Port</label><select id="u_port"><option value="">Select device first...</option></select></div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn primary" onclick="submitAddUplink(${vsId})">Add</button>
    </div>`);
}

async function onUplinkDeviceChange() {
  const deviceId = document.getElementById("u_device").value;
  const sel = document.getElementById("u_port");
  if (!deviceId) { sel.innerHTML = `<option value="">Select device first...</option>`; return; }
  const d = await api(`/api/devices/${deviceId}`);
  sel.innerHTML = d.ports.length
    ? d.ports.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join("")
    : `<option value="">(no ports on this device)</option>`;
}

async function submitAddUplink(vsId) {
  const portId = Number(document.getElementById("u_port").value);
  if (!portId) {
    document.getElementById("uplinkModalError").innerHTML = `<div class="error-msg">Pick a port.</div>`;
    return;
  }
  try {
    await api(`/api/devices/${vsId}/uplinks`, { method: "POST", body: JSON.stringify({ port_id: portId }) });
    closeModal();
    showToast("Uplink added");
    viewDevice(vsId);
  } catch (e) {
    document.getElementById("uplinkModalError").innerHTML = `<div class="error-msg">${esc(e.message)}</div>`;
  }
}

async function removeUplink(uplinkId, vsId) {
  try {
    await api(`/api/uplinks/${uplinkId}`, { method: "DELETE" });
    showToast("Uplink removed");
    viewDevice(vsId);
  } catch (e) { showToast(e.message, true); }
}

// --- LAGs (bonded port groups) ---
function openAddLagModal(deviceId, ports) {
  renderModal(`
    <h3>Add LAG</h3>
    <p class="note">Groups two or more of this device's own physical ports into one bonded logical link (e.g. two NICs bonded on a NAS, or a switch-to-switch trunk over two cables). Each port keeps its own individual cable -- this just marks them as bonded together.</p>
    <div id="lagModalError"></div>
    <div class="field"><label>LAG name</label><input type="text" id="lag_name"></div>
    <div class="field"><label>Member ports</label>
      ${ports.map(p => `<label class="checkbox-field" style="display:flex; margin-bottom:6px;">
          <input type="checkbox" class="lag_member" value="${p.id}"> ${esc(cleanPortLabel(p.name))}
        </label>`).join("")}
    </div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn primary" onclick="submitAddLag(${deviceId})">Add</button>
    </div>`);
}

async function submitAddLag(deviceId) {
  const name = document.getElementById("lag_name").value;
  const memberIds = Array.from(document.querySelectorAll(".lag_member:checked")).map(el => Number(el.value));
  const errBox = document.getElementById("lagModalError");
  if (!name.trim()) {
    errBox.innerHTML = `<div class="error-msg">Name the LAG.</div>`;
    return;
  }
  if (memberIds.length < 2) {
    errBox.innerHTML = `<div class="error-msg">Pick at least two ports to bond together.</div>`;
    return;
  }
  try {
    const lag = await api(`/api/devices/${deviceId}/lags`, { method: "POST", body: JSON.stringify({ name }) });
    for (const portId of memberIds) {
      await api(`/api/ports/${portId}/lag`, { method: "POST", body: JSON.stringify({ lag_id: lag.id }) });
    }
    closeModal();
    showToast("LAG added");
    viewDevice(deviceId);
  } catch (e) {
    errBox.innerHTML = `<div class="error-msg">${esc(e.message)}</div>`;
  }
}

async function deleteLag(lagId, deviceId) {
  if (!confirm("Delete this LAG grouping? The member ports and their cables aren't affected -- they just stop being marked as bonded.")) return;
  try {
    await api(`/api/lags/${lagId}`, { method: "DELETE" });
    showToast("LAG deleted");
    viewDevice(deviceId);
  } catch (e) { showToast(e.message, true); }
}

// ---------------------------------------------------------------------------
// Footer
// ---------------------------------------------------------------------------
document.getElementById("verYear").textContent = new Date().getFullYear();
api("/api/meta").then(meta => {
  document.getElementById("verNum").textContent = meta.version;
});

// ---------------------------------------------------------------------------
// Startup: show the login screen if no one's signed in, else render the app.
// ---------------------------------------------------------------------------
api("/api/whoami").then(who => {
  if (!who.role) {
    showLoginScreen();
    return;
  }
  CURRENT_ROLE = who.role;
  CURRENT_USERNAME = who.username;
  document.getElementById("whoami").textContent = who.username ? `Signed in as ${who.username}` : "";
  showMainApp();
  applyRoleVisibility();
  navigateTo(initialStateFromUrl(), { replace: true });
  if (who.admin_default_password) showDefaultPasswordReminder();
});

// Shown on every admin login while the admin account still has its
// default password. Stops once that password is changed from Settings.
function showDefaultPasswordReminder() {
  renderModal(`
    <h3>Change the default admin password</h3>
    <p>This admin account is still using its default password (the one
    documented in the README) -- anyone who knows it can sign in as admin
    and change anything. Set a real password from Settings before this
    instance is reachable by anyone you don't want to have full access.</p>
    <p>New to LinkLedger? The tutorial walks through the basics with a
    sample dataset you can load in and try things out on first.</p>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Remind me later</button>
      <button class="btn" onclick="closeModal(); window.open('/static/tutorial.html', '_blank');">View tutorial</button>
      <button class="btn primary" onclick="location.href='/static/settings.html'">Change password now</button>
    </div>`);
}
