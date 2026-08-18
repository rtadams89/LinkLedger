// ---------------------------------------------------------------------------
// Browser back/forward -- this is a single-page app with no real page loads,
// so the History API is used to give the mouse/keyboard back and forward
// buttons a real place to go: through LinkLedger's own view history (Device
// A -> Device B -> back -> Device A), the same way they'd work on any
// multi-page site. Every navigation (see navigateTo() below) pushes one
// history entry describing that view; popstate re-renders whatever view the
// browser lands back on. Running out of app history and pressing back again
// leaves LinkLedger entirely, same as leaving any other site -- that's the
// correct trade-off for real back-button support, not a bug.
//
// Each history entry also carries the scrollY the page was at when you
// navigated *away* from it (stamped on just before the new view renders),
// so back/forward restores your place the way normal browser navigation
// does; navigating forward to a new view always starts at the top.
// ---------------------------------------------------------------------------
// Tell the browser not to do its own scroll-position guessing on
// popstate -- with pushState-driven views like this, its guess races our
// own render + scrollTo below and can win, producing a visible flicker to
// the wrong position before landing on the right one. "manual" leaves
// scroll restoration entirely to the code below.
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
    // Not signed in (or the session expired/was invalidated elsewhere) --
    // reload so the bootstrap whoami check shows the login screen instead
    // of leaving the page in a half-broken, half-authenticated state.
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

// Password changes, backup/restore, and reset-data all moved to the
// Settings page (settings.html / settings.js) in v1.8.0 -- this file no
// longer has modals for any of them.

function applyRoleVisibility() {
  // .admin-only defaults to display:none in the stylesheet (fail closed).
  // For admins we strip the class so elements fall back to their normal
  // display; re-rendered content (device view, etc) gets the class fresh
  // each time, so this needs to run after every dynamic re-render.
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

// Roles whose ports can be tagged with VLAN(s) and "Supplies PoE" -- kept
// in sync with db.VLAN_POE_CAPABLE_ROLES on the backend.
const VLAN_POE_CAPABLE_ROLES = ["Switch", "Router/Firewall"];

// Roles with no physical ports of their own -- they bridge together
// uplinks (real ports elsewhere) and members (ports that join them
// instead of being cabled). Kept in sync with db.VIRTUAL_SWITCH_ROLES.
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

// Same as esc(), plus a <wbr> (word-break opportunity) after every "." and
// "-" -- for a long dotted hostname like a device's mDNS name, this lets a
// cramped result-list row wrap at a sensible boundary ("some-device.
// home.example.com") instead of splitting an arbitrary run of letters in
// the middle. Only used for names in search-result rows, which are narrow
// enough for this to matter; everywhere else just uses plain esc().
function escBreakable(s) {
  return esc(s).replace(/([.-])/g, "$1<wbr>");
}

// ---------------------------------------------------------------------------
// Tabs / views
//
// Four views: "browse" (the searchable/filterable device grid -- always
// just the grid, never a specific device), "device" (one device's detail
// page), "path" (path finder), "reports". Browse and Device are
// deliberately separate views with their own containers -- a device page
// used to be rendered inside the Browse tab's own container, which is why
// it also used to drag along a redundant mini "All devices" grid at the
// bottom; splitting them out removes the need for that entirely.
//
// renderView() is the one function that actually draws a view -- it has no
// history/scroll side effects, so it's safe to call from popstate. Every
// user-initiated navigation goes through navigateTo() instead, which
// additionally stamps the outgoing view's scroll position, renders the new
// view, and pushes a history entry for it (see the popstate listener up
// top). Refreshing the currently-open device in place after an edit (add a
// port, rename it, etc.) is neither of those -- see refreshCurrentDevice().
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
  document.getElementById("tabReports").classList.toggle("active", tab === "reports");
  document.getElementById("browseView").style.display = tab === "browse" ? "block" : "none";
  document.getElementById("deviceView").style.display = tab === "device" ? "block" : "none";
  document.getElementById("pathView").style.display = tab === "path" ? "block" : "none";
  document.getElementById("reportsView").style.display = tab === "reports" ? "block" : "none";
  // The Device tab only makes sense once a device has actually been
  // viewed -- there's nothing to show it for on a brand-new session, so it
  // stays hidden until then, and (once shown) stays visible/clickable from
  // any other tab so you can always jump back to the last device you were
  // looking at, the same way clicking a browser back-forward-history entry
  // would land you back on it.
  document.getElementById("tabDevice").style.display = lastViewedDeviceId ? "" : "none";

  if (tab === "device" && state.id) await renderDeviceView(state.id);
  else if (tab === "path") await renderPathFinder();
  else if (tab === "reports") await renderReportsView();
  else await renderBrowseHome();
}

async function navigateTo(state, opts) {
  opts = opts || {};
  if (!opts.replace && history.state) {
    // Stamp how far down the page we'd scrolled onto the entry we're
    // leaving, so a later "back" to it can restore that position.
    history.replaceState({ ...history.state, scrollY: window.scrollY }, "", location.href);
  }
  await renderView(state);
  history[opts.replace ? "replaceState" : "pushState"]({ ...state, scrollY: 0 }, "", location.href);
  window.scrollTo(0, 0);
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
      `<div class="result-item" onclick="viewDevice(${d.id})"><span>${escBreakable(d.name)}</span>${roleBadge(d.role)}</div>`
    ).join("");
  }
  resultsBox.classList.add("show");
});
// Closes any open autocomplete dropdown (the main search bar, or a path
// finder device field) when clicking outside its own wrapper.
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
  return `<button class="device-chip" onclick="viewDevice(${d.id})" title="${esc(d.name)}">
    <span class="chip-name">${esc(d.name)}</span><span class="role">${esc(d.role || "—")}</span>
  </button>`;
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

// Shown on a port that belongs to a device flagged as needing PoE --
// green if the far-end switch port actually supplies it, amber if not.
function poeNeedTag(deviceRequiresPoe, supplied) {
  if (!deviceRequiresPoe) return "";
  return supplied
    ? `<span class="tag poe-tag-ok">&#9889; PoE OK</span>`
    : `<span class="tag poe-tag-warn">&#9889; needs PoE, not supplied</span>`;
}

// Short plain-text summary of what a port's trace currently ends at --
// used in the Connect port modal's port pickers to label an already-in-use
// port, so a device/port that's occupied can still be picked (and
// overwritten, with a warning) instead of being disabled outright.
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
      return `<span class="arrow">&rarr;</span> <a class="link" title="${esc(h.device_name)}" onclick="viewDevice(${h.device_id})">${esc(h.device_name)}</a> <span class="via">(${kind}${via})</span>`;
    }
    const label = cleanPortLabel(h.port_name);
    return `<span class="arrow">&rarr;</span> <a class="link" title="${esc(h.device_name)}" onclick="viewDevice(${h.device_id})">${esc(h.device_name)}</a> <span class="via">(${esc(label)})</span>`;
  }).join(" ");
  const extras = `${speedTag(effectiveSpeed)}${vlanTag(effectiveVlans)}`;
  return `${path}${extras ? " " + extras : ""}`;
}

function uplinkRows(d) {
  return `<table><tr><th>Uplink port</th><th></th></tr>${
    d.uplinks.length
      ? d.uplinks.map(u => `<tr>
          <td><a class="link" onclick="viewDevice(${u.device_id})">${esc(u.device_name)}</a> <span class="via">(${esc(cleanPortLabel(u.port_name))})</span></td>
          <td>${isAdmin() ? `<button class="icon-btn" title="Remove uplink" onclick="removeUplink(${u.id}, ${d.id})">&#128465;</button>` : ""}</td>
        </tr>`).join("")
      : `<tr><td colspan="2"><span class="unused">no uplinks yet -- this ${esc(d.role)} can't reach the rest of the network</span></td></tr>`
  }</table>`;
}

function memberRows(d) {
  return `<table><tr><th>Member</th><th>VLAN</th></tr>${
    d.members.length
      ? d.members.map(m => `<tr>
          <td><a class="link" onclick="viewDevice(${m.device_id})">${esc(m.device_name)}</a> <span class="via">(${esc(cleanPortLabel(m.port_name))})</span> ${roleBadge(m.device_role)}</td>
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

// Navigate TO a device -- from a search result, a device chip, a link in a
// port's connection chain, an uplink/member row, a report, whatever. Pushes
// a history entry and scrolls to top; see the "Tabs / views" section above.
async function viewDevice(id) {
  searchInput.value = "";
  resultsBox.classList.remove("show");
  await navigateTo({ tab: "device", id });
}

// Re-render the currently-open device's page in place after an edit made
// from it (add/edit/delete a port, rename the device, add an uplink or LAG,
// connect/disconnect a cable, etc.) -- NOT a navigation, so no history entry
// and no scroll-to-top; you stay exactly where you were on the page. A
// no-op if a device page isn't what's currently open (e.g. a cable created
// from the global "+ New cable" button while looking at the device grid).
async function refreshCurrentDevice() {
  if (currentDeviceId) await renderDeviceView(currentDeviceId);
}

async function renderDeviceView(id) {
  let d;
  try {
    d = await api(`/api/devices/${id}`);
  } catch (e) {
    // Most likely landed here via browser back/forward onto a device
    // that's since been deleted -- rather than an unhandled failure, show
    // a way back instead of a blank page.
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
    d.ports.forEach(p => {
      const m = p.name.match(/^(\d+) \((rear|front)\)$/);
      if (m) (m[2] === "rear" ? rearMap : frontMap)[m[1]] = p;
    });
    const nums = [...new Set([...Object.keys(rearMap), ...Object.keys(frontMap)])]
      .sort((a, b) => Number(a) - Number(b));
    portRows = nums.map(n => {
      const rear = rearMap[n], front = frontMap[n];
      return `<tr>
        <td class="port-name">Port ${n}</td>
        <td class="chain">device side ${rear ? chainHTML(rear.trace, rear.effective_speed, rear.effective_vlans) + portActions(rear, d.role) : "—"}</td>
        <td class="chain">switch side ${front ? chainHTML(front.trace, front.effective_speed, front.effective_vlans) + portActions(front, d.role) : "—"}</td>
      </tr>`;
    }).join("");
    portRows = `<table><tr><th>Port</th><th>Device side (rear)</th><th>Switch side (front)</th></tr>${portRows}</table>`;
    extraButtons = `<button class="btn small admin-only" onclick="openPortModal(${d.id})">+ Add port(s)</button>
        <button class="btn small admin-only" onclick="openPatchPanelModal(${d.id})">+ Add N paired ports</button>`;
  } else {
    portRows = `<table><tr><th>Port / NIC</th><th>Connected to</th><th></th></tr>` +
      d.ports.map(p => `<tr>
        <td class="port-name">${esc(p.name)} ${speedTag(p.speed)}${VLAN_POE_CAPABLE_ROLES.includes(d.role) ? poeSupplyTag(p.poe_supply) + vlanTag(p.vlans) : (p.virtual_switch_id ? vlanTag(p.vlans) : "")}${lagTag(p.lag_name)}</td>
        <td class="chain">${chainHTML(p.trace, p.effective_speed, p.effective_vlans)} ${poeNeedTag(d.poe_required, p.poe_supplied)}</td>
        <td>${portActions(p, d.role)}</td>
      </tr>`).join("") + `</table>`;
    portRows += lagRows(d);
    extraButtons = `<button class="btn small admin-only" onclick="openPortModal(${d.id})">+ Add port(s)</button>` +
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
        <button class="btn small admin-only" onclick="openDeviceModal(${d.id})">Edit</button>
        <button class="btn small danger admin-only" onclick="confirmDeleteDevice(${d.id}, '${esc(d.name).replace(/'/g, "\\'")}')">Delete</button>
      </div>
      ${d.notes ? `<p class="note">${esc(d.notes)}</p>` : ""}
      ${portRows}
      ${extraButtons ? `<div style="margin-top:12px; display:flex; gap:8px;" class="print-hide">${extraButtons}</div>` : ""}
    </div>`;
  applyRoleVisibility();
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
    deviceRole, virtual_switch_id: p.virtual_switch_id,
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

// Last-fetched device's ports for each side, kept around so
// onPathPortChange can look up the chosen NIC's virtual_switch_id without
// a round-trip -- populated by onPathDeviceChange whenever device A/B
// changes.
let PF_PORTS = { a: [], b: [] };

async function onPathDeviceSearch(which) {
  const q = document.getElementById(`pf_${which}Search`).value.trim();
  const box = document.getElementById(`pf_${which}Results`);
  if (!q) { box.classList.remove("show"); return; }
  const matches = await api(`/api/devices?q=${encodeURIComponent(q)}`);
  box.innerHTML = matches.length
    ? matches.map(d => `<div class="result-item" onclick="selectPathDevice('${which}', ${d.id}, '${esc(d.name).replace(/'/g, "\\'")}')"><span>${escBreakable(d.name)}</span>${roleBadge(d.role)}</div>`).join("")
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
  // Devices with just one port can skip the extra click; anything with
  // more than one forces an explicit pick rather than silently defaulting
  // to whichever NIC happens to be first.
  const placeholder = d.ports.length > 1 ? `<option value="">Select a NIC...</option>` : "";
  sel.innerHTML = placeholder + d.ports.map(p => `<option value="${p.id}">${esc(cleanPortLabel(p.name))}</option>`).join("");
  // A single-port device auto-fills the NIC without an extra click -- still
  // run the wireless/virtual-link check for it, same as a manual pick.
  if (d.ports.length === 1) onPathPortChange(which);
}

function clearPathVia(which) {
  document.getElementById(`pf_${which}ViaWrap`).innerHTML = "";
}

// If the chosen NIC is a virtual link member of an AP Group / Virtual
// Switch, offer a way to pin the search to one specific uplink instead of
// leaving it to find_path() to pick whichever gives the shortest route
// (see submitFindPath / pathfind.find_path). A no-op for a normal wired
// NIC (no virtual_switch_id at all). If the virtual switch has only one
// uplink on record, there's nothing to actually choose between -- but
// it's still shown (disabled, that one uplink pre-filled) rather than
// nothing, so it's clear at a glance which uplink the path goes through
// and that this NIC IS recognized as wireless/virtual, rather than
// looking like the feature just doesn't apply here.
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
  // Patch panels enter/exit on the (rear)/(front) suffix of the SAME
  // number -- stripping it like elsewhere would show "21 -> 21", which
  // looks like a no-op instead of the rear->front pass-through it is.
  const isPanel = seg.device_role === "Patch Panel";
  const portLabels = seg.ports.map(p => isPanel ? p.port_name : cleanPortLabel(p.port_name));
  const portDisplay = portLabels.length > 1
    ? `${esc(portLabels[0])} &rarr; ${esc(portLabels[portLabels.length - 1])}`
    : esc(portLabels[0]);
  const poeBits = seg.ports.filter(p => p.poe_supply).length
    ? poeSupplyTag(true)
    : "";
  return `<div class="path-hop">
    <div class="path-hop-device"><a class="link" title="${esc(seg.device_name)}" onclick="viewDevice(${seg.device_id})">${esc(seg.device_name)}</a> ${roleBadge(seg.device_role)}</div>
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

    resultBox.innerHTML = `
      <div class="card">
        <div class="path-summary">
          ${speedTag(p.overall_speed) || `<span class="note">Speed not tagged along this path</span>`}
          ${p.routed_via_router ? `<span class="tag" style="background:#ffedd5;color:#c2410c;">Routes through a Router/Firewall</span>` : `<span class="tag" style="background:#dcfce7;color:#15803d;">Direct switch path -- no router hop</span>`}
        </div>
        <div class="vlan-note ${vlanClass}">${esc(p.vlan_note.detail)}</div>
        <div class="path-chain">${hops}</div>
      </div>`;
  } catch (e) {
    resultBox.innerHTML = `<div class="card"><div class="error-msg">${esc(e.message)}</div></div>`;
  }
}

// ---------------------------------------------------------------------------
// Modal plumbing
// ---------------------------------------------------------------------------
function closeModal() { document.getElementById("modalRoot").innerHTML = ""; }
function renderModal(html) { document.getElementById("modalRoot").innerHTML = `<div class="modal-backdrop" onclick="if(event.target===this) closeModal()"><div class="modal">${html}</div></div>`; }

// --- Add/edit device ---
async function openDeviceModal(deviceId) {
  const [d, roleSettings, sites] = await Promise.all([
    deviceId ? api(`/api/devices/${deviceId}`) : Promise.resolve({ name: "", role: "", model: "", site: "", notes: "", poe_required: false }),
    api("/api/settings/roles"),
    api("/api/sites"),
  ]);
  // Role dropdown options come from Settings -> Device roles
  // (crud.get_enabled_roles) instead of always showing the full fixed
  // list, same idea as the speed picker below. If the device's current
  // role isn't in that enabled set (old data, a CSV import, or a role
  // that's since been hidden), keep it selectable anyway so saving the
  // modal doesn't silently blank it out.
  const roleNames = roleSettings.enabled.slice();
  if (d.role && !roleNames.includes(d.role)) roleNames.push(d.role);
  // Same idea for site: it's a plain user-managed list (Settings -> Sites),
  // so a value that isn't (or no longer is) in that list -- from before the
  // list existed, a CSV import, or a site since renamed/removed -- still
  // shows up here as an extra option instead of getting silently blanked.
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
    // The Device tab (and browser back/forward) can no longer point at
    // this device -- drop it so the tab hides again and nothing tries to
    // re-render a device that's gone.
    if (lastViewedDeviceId === id) lastViewedDeviceId = null;
    await navigateTo({ tab: "browse" });
  } catch (e) { showToast(e.message, true); }
}

// --- Add ports ---
async function openPortModal(deviceId) {
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
  try {
    if (names.length === 1) {
      await api(`/api/devices/${deviceId}/ports`, { method: "POST", body: JSON.stringify({ name: names[0], speed }) });
    } else {
      await api(`/api/devices/${deviceId}/ports/bulk`, { method: "POST", body: JSON.stringify({ names, speed }) });
    }
    closeModal();
    showToast(`Added ${names.length} port(s)`);
    viewDevice(deviceId);
  } catch (e) {
    document.getElementById("portModalError").innerHTML = `<div class="error-msg">${esc(e.message)}</div>`;
  }
}

function openPatchPanelModal(deviceId) {
  renderModal(`
    <h3>Add paired patch panel ports</h3>
    <p class="note">Creates N front/rear port pairs, pre-linked so traces pass straight through — e.g. 24 for a standard panel.</p>
    <div id="panelModalError"></div>
    <div class="field"><label>Number of ports</label><input type="number" id="f_count" value="24" min="1" max="96"></div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn primary" onclick="submitPatchPanel(${deviceId})">Add</button>
    </div>`);
}

async function submitPatchPanel(deviceId) {
  const count = Number(document.getElementById("f_count").value);
  try {
    await api(`/api/devices/${deviceId}/patch-panel`, { method: "POST", body: JSON.stringify({ count }) });
    closeModal();
    showToast(`Added ${count} paired ports`);
    viewDevice(deviceId);
  } catch (e) {
    document.getElementById("panelModalError").innerHTML = `<div class="error-msg">${esc(e.message)}</div>`;
  }
}

// The port speed picker's options come from Settings -> Interface speeds
// (crud.get_enabled_speeds) instead of a fixed list, so a network that'll
// never see anything above 1G doesn't have to scroll past 2.5G/5G/10G/25G/
// 40G/100G every single time. Always includes "" (not set) first, and
// whatever the port's OWN current value already is even if it's since been
// hidden from the picker -- same "don't silently blank existing data"
// pattern used for role/site above.
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
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn primary" onclick="submitEditPort(${port.id})">Save</button>
    </div>`);
}

async function submitEditPort(portId) {
  const body = {
    name: document.getElementById("ep_name").value,
    speed: document.getElementById("ep_speed").value,
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
// Reports -- read-only data-quality checks (see crud.data_quality_report on
// the backend). Nothing here is editable; every list item links back to
// the actual device via viewDevice() so fixing something found here is
// just a click away.
// ---------------------------------------------------------------------------

function reportSection(title, note, count, bodyHtml) {
  return `
    <div class="card">
      <div class="device-header">
        <strong>${esc(title)}</strong>
        <span class="tag" style="background:${count ? "#fef2f2" : "#dcfce7"}; color:${count ? "#b91c1c" : "#15803d"};">${count}</span>
      </div>
      <p class="note" style="margin:0 0 10px;">${note}</p>
      ${count === 0 ? `<div class="empty-state">Nothing to report here.</div>` : bodyHtml}
    </div>`;
}

function reportPortsTable(ports) {
  return `<table><tr><th>Device</th><th>Port</th></tr>
    ${ports.map(p => `<tr>
      <td><a class="link" onclick="viewDevice(${p.device_id})">${esc(p.device_name)}</a> ${roleBadge(p.device_role)}</td>
      <td class="port-name">${esc(cleanPortLabel(p.name))}</td>
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

async function renderReportsView() {
  const box = document.getElementById("reportsView");
  box.innerHTML = `<div class="card"><div class="empty-state">Loading…</div></div>`;
  let r;
  try {
    r = await api("/api/reports");
  } catch (e) {
    box.innerHTML = `<div class="card"><div class="error-msg">${esc(e.message)}</div></div>`;
    return;
  }

  const devGrid = devices => `<div class="device-grid">${devices.map(deviceChip).join("")}</div>`;
  const unmanagedCount = r.unmanaged_site_values.reduce((n, g) => n + g.devices.length, 0);

  box.innerHTML = [
    reportSection("Devices missing a site", "Devices with no Site value set.",
      r.missing_site.length, devGrid(r.missing_site)),

    reportSection("Devices missing a model", "Devices with no Model value set.",
      r.missing_model.length, devGrid(r.missing_model)),

    reportSection("Devices missing a role",
      "Devices with no Role set &mdash; role drives VLAN/PoE options, path finding, and more, so these are worth a look.",
      r.missing_role.length, devGrid(r.missing_role)),

    reportSection("Site values not in your managed list",
      "Devices whose Site is set to a value that isn't in Settings &rarr; Sites &mdash; could be a typo, data from before the list existed, or a site that's since been renamed/removed there.",
      unmanagedCount, reportUnmanagedSites(r.unmanaged_site_values)),

    reportSection("Ports missing a speed",
      "Ports with no Speed set (excludes patch panel pass-through ports and wireless/virtual member links, which don't have a speed of their own).",
      r.missing_speed.length, reportPortsTable(r.missing_speed)),

    reportSection("Unused ports",
      "Ports with no cable, no pairing, and no wireless/virtual link &mdash; just sitting there unconnected.",
      r.unused_ports.length, reportPortsTable(r.unused_ports)),

    reportSection("AP Groups / Virtual Switches with no uplinks",
      "These have no way to actually reach the rest of the network yet &mdash; add at least one uplink from the device's own page.",
      r.no_uplinks.length, devGrid(r.no_uplinks)),

    reportSection("Devices with no ports",
      "Devices added but never given any ports yet.",
      r.no_ports.length, devGrid(r.no_ports)),

    reportSection("“Requires PoE” devices not actually getting it",
      "Devices flagged Requires PoE where nothing along any port's trace is tagged as supplying it.",
      r.poe_unmet.length, devGrid(r.poe_unmet)),
  ].join("");
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
    ? matches.map(d => `<div class="result-item" onclick="selectConnectDevice('${which}', ${d.id}, '${esc(d.name).replace(/'/g, "\\'")}')"><span>${escBreakable(d.name)}</span>${roleBadge(d.role)}</div>`).join("")
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

// Populates the From/To port select for whichever device was just picked.
// A port already in use is still selectable (not disabled) -- its label
// just says what it's currently connected to -- so picking one and
// confirming the warning in submitConnect() moves that connection here in
// one step instead of requiring a separate disconnect first. If a device
// has literally no ports at all yet, there's nothing to pick except
// "+ Add a new port...", so that's auto-selected and its inline create
// field opens right away instead of leaving the select on an unusable/
// blank-looking state.
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
    // Nothing selectable except "+ Add a new port..." -- it'll land there
    // as the default selection, so open the inline creator right away.
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

// Backup/Restore and Reset data all moved to the Settings page in v1.8.0 --
// see settings.html / settings.js.

// ---------------------------------------------------------------------------
// Footer
// ---------------------------------------------------------------------------
document.getElementById("verYear").textContent = new Date().getFullYear();
api("/api/meta").then(meta => {
  document.getElementById("verNum").textContent = meta.version;
});

// ---------------------------------------------------------------------------
// Startup: figure out who's signed in (if anyone) before rendering anything.
// Not signed in -> show the login screen instead of the app.
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
  navigateTo({ tab: "browse" }, { replace: true });
  if (who.admin_default_password) showDefaultPasswordReminder();
});

// Shown on every admin login for as long as the admin account still has
// its out-of-the-box default password (see api_whoami's
// admin_default_password field) -- disappears for good, permanently, the
// moment that password is actually changed from Settings; there's no
// "don't remind me" dismissal to build or store, since the condition
// itself is what stops it from showing again.
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
