// ---------------------------------------------------------------------------
// Settings page: Backup/Restore, account passwords, and Reset data. A
// standalone page with its own small copies of the helpers it needs.
// ---------------------------------------------------------------------------

async function api(path, options) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  let body = null;
  try { body = await res.json(); } catch (e) { /* no body */ }
  if (!res.ok) {
    const msg = (body && body.detail) ? body.detail : `request failed (${res.status})`;
    throw new Error(msg);
  }
  return body;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function showToast(msg, isError) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.style.background = isError ? "#dc2626" : "#0f172a";
  t.classList.add("show");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => t.classList.remove("show"), 2600);
}

let CURRENT_ROLE = null;
function isAdmin() { return CURRENT_ROLE === "admin"; }

function applyRoleVisibility() {
  // .admin-only defaults to display:none in the stylesheet.
  document.querySelectorAll(".admin-only").forEach(el => {
    if (isAdmin()) el.classList.remove("admin-only");
    else el.style.display = "none";
  });
}

// --- Sites ---
let SITES_CACHE = [];

async function loadSites() {
  try {
    SITES_CACHE = await api("/api/sites");
    renderSitesList();
  } catch (e) {
    document.getElementById("sitesError").innerHTML = `<div class="error-msg">${esc(e.message)}</div>`;
  }
}

function renderSitesList() {
  const box = document.getElementById("sitesList");
  if (SITES_CACHE.length === 0) {
    box.innerHTML = `<div class="empty-state">No sites yet — add one below.</div>`;
    return;
  }
  box.innerHTML = SITES_CACHE.map(s => `
    <div class="row-actions" style="justify-content:space-between; padding:6px 0; border-bottom:1px solid #f1f5f9;">
      <span>${esc(s.name)}</span>
      <span class="row-actions">
        <button class="btn small" onclick='promptRenameSite(${s.id}, ${JSON.stringify(s.name).replace(/'/g, "&#39;")})'>Rename</button>
        <button class="btn small danger" onclick='confirmDeleteSite(${s.id}, ${JSON.stringify(s.name).replace(/'/g, "&#39;")})'>Delete</button>
      </span>
    </div>`).join("");
}

async function submitAddSite() {
  const input = document.getElementById("f_newSite");
  const name = input.value.trim();
  const errBox = document.getElementById("sitesError");
  errBox.innerHTML = "";
  if (!name) return;
  try {
    await api("/api/sites", { method: "POST", body: JSON.stringify({ name }) });
    input.value = "";
    showToast("Site added");
    loadSites();
  } catch (e) {
    errBox.innerHTML = `<div class="error-msg">${esc(e.message)}</div>`;
  }
}

async function promptRenameSite(id, currentName) {
  const next = prompt("Rename site:", currentName);
  if (next === null) return;
  const trimmed = next.trim();
  if (!trimmed || trimmed === currentName) return;
  try {
    await api(`/api/sites/${id}`, { method: "PUT", body: JSON.stringify({ name: trimmed }) });
    showToast("Site renamed");
    loadSites();
  } catch (e) {
    document.getElementById("sitesError").innerHTML = `<div class="error-msg">${esc(e.message)}</div>`;
  }
}

async function confirmDeleteSite(id, name) {
  if (!confirm(`Delete site "${name}"? Devices already set to it keep that value -- it just won't be offered for new picks anymore.`)) return;
  try {
    await api(`/api/sites/${id}`, { method: "DELETE" });
    showToast("Site deleted");
    loadSites();
  } catch (e) {
    document.getElementById("sitesError").innerHTML = `<div class="error-msg">${esc(e.message)}</div>`;
  }
}

// --- Device roles ---
let ROLES_CACHE = { all: [], enabled: [] };

async function loadRoleSettings() {
  try {
    ROLES_CACHE = await api("/api/settings/roles");
    renderRolesList();
  } catch (e) {
    document.getElementById("rolesError").innerHTML = `<div class="error-msg">${esc(e.message)}</div>`;
  }
}

function renderRolesList() {
  const box = document.getElementById("rolesList");
  box.innerHTML = ROLES_CACHE.all.map(r => `
    <label class="checkbox-field" style="display:inline-flex; width:auto; margin-right:18px; margin-bottom:6px;">
      <input type="checkbox" value="${esc(r)}" class="roleCheckbox" ${ROLES_CACHE.enabled.includes(r) ? "checked" : ""}> ${esc(r)}
    </label>`).join("");
}

async function submitRoleSettings() {
  const checked = Array.from(document.querySelectorAll(".roleCheckbox:checked")).map(el => el.value);
  const errBox = document.getElementById("rolesError");
  errBox.innerHTML = "";
  try {
    await api("/api/settings/roles", { method: "PUT", body: JSON.stringify({ roles: checked }) });
    showToast("Role settings saved");
    loadRoleSettings();
  } catch (e) {
    errBox.innerHTML = `<div class="error-msg">${esc(e.message)}</div>`;
  }
}

// --- Interface speeds ---
let SPEEDS_CACHE = { all: [], enabled: [] };

async function loadSpeedSettings() {
  try {
    SPEEDS_CACHE = await api("/api/settings/speeds");
    renderSpeedsList();
  } catch (e) {
    document.getElementById("speedsError").innerHTML = `<div class="error-msg">${esc(e.message)}</div>`;
  }
}

function renderSpeedsList() {
  const box = document.getElementById("speedsList");
  box.innerHTML = SPEEDS_CACHE.all.map(s => `
    <label class="checkbox-field" style="display:inline-flex; width:auto; margin-right:18px; margin-bottom:6px;">
      <input type="checkbox" value="${esc(s)}" class="speedCheckbox" ${SPEEDS_CACHE.enabled.includes(s) ? "checked" : ""}> ${esc(s)}
    </label>`).join("");
}

async function submitSpeedSettings() {
  const checked = Array.from(document.querySelectorAll(".speedCheckbox:checked")).map(el => el.value);
  const errBox = document.getElementById("speedsError");
  errBox.innerHTML = "";
  try {
    await api("/api/settings/speeds", { method: "PUT", body: JSON.stringify({ speeds: checked }) });
    showToast("Speed settings saved");
    loadSpeedSettings();
  } catch (e) {
    errBox.innerHTML = `<div class="error-msg">${esc(e.message)}</div>`;
  }
}

// --- Reports shown ---
let REPORTS_CACHE = { all: [], enabled: [] };

async function loadReportSettings() {
  try {
    REPORTS_CACHE = await api("/api/settings/reports");
    renderReportSettingsList();
  } catch (e) {
    document.getElementById("reportsError").innerHTML = `<div class="error-msg">${esc(e.message)}</div>`;
  }
}

function renderReportSettingsList() {
  const box = document.getElementById("reportsList");
  box.innerHTML = REPORTS_CACHE.all.map(r => `
    <label class="checkbox-field" style="display:flex; margin-bottom:6px;">
      <input type="checkbox" value="${esc(r.key)}" class="reportCheckbox" ${REPORTS_CACHE.enabled.includes(r.key) ? "checked" : ""}> ${esc(r.title)}
    </label>`).join("");
}

async function submitReportSettings() {
  const checked = Array.from(document.querySelectorAll(".reportCheckbox:checked")).map(el => el.value);
  const errBox = document.getElementById("reportsError");
  errBox.innerHTML = "";
  try {
    await api("/api/settings/reports", { method: "PUT", body: JSON.stringify({ reports: checked }) });
    showToast("Report settings saved");
    loadReportSettings();
  } catch (e) {
    errBox.innerHTML = `<div class="error-msg">${esc(e.message)}</div>`;
  }
}

// --- pfSense device discovery ---
let PFSENSE_CACHE = [];
let PFSENSE_EDIT_SELECTED = new Set();  // interfaces checked in the currently-open editor

async function loadPfsenseInstances() {
  try {
    PFSENSE_CACHE = await api("/api/settings/pfsense");
    renderPfsenseList();
    populatePfsenseSiteOptions();
  } catch (e) {
    document.getElementById("pfsenseError").innerHTML = `<div class="error-msg">${esc(e.message)}</div>`;
  }
}

function populatePfsenseSiteOptions() {
  const sel = document.getElementById("pf_site");
  if (!sel) return;
  const current = sel.value;
  sel.innerHTML = `<option value="">(none)</option>` +
    SITES_CACHE.map(s => `<option value="${esc(s.name)}">${esc(s.name)}</option>`).join("");
  sel.value = current;
}

function renderPfsenseList() {
  const box = document.getElementById("pfsenseList");
  if (PFSENSE_CACHE.length === 0) {
    box.innerHTML = `<div class="empty-state">No pfSense instances yet — add one below.</div>`;
    return;
  }
  box.innerHTML = PFSENSE_CACHE.map(inst => {
    let status;
    if (!inst.last_sync_at) status = "never synced yet";
    else if (inst.last_sync_status === "ok") status = `last synced ${esc(inst.last_sync_at)}`;
    else status = `<span style="color:#dc2626;">${esc(inst.last_sync_status || "sync failed")}</span>`;
    return `
    <div class="row-actions" style="justify-content:space-between; padding:8px 0; border-bottom:1px solid #f1f5f9;">
      <span>
        <strong>${esc(inst.name)}</strong>${inst.site ? ` &middot; ${esc(inst.site)}` : ""}
        ${inst.enabled ? "" : `<span style="color:#94a3b8;"> (disabled)</span>`}
        <br><small style="color:#64748b;">${status}</small>
      </span>
      <span class="row-actions">
        <button class="btn small" onclick="syncPfsenseNow(${inst.id})">Sync now</button>
        <button class="btn small" onclick="openPfsenseEditor(${inst.id})">Edit</button>
        <button class="btn small danger" onclick='confirmDeletePfsenseInstance(${inst.id}, ${JSON.stringify(inst.name).replace(/'/g, "&#39;")})'>Delete</button>
      </span>
    </div>`;
  }).join("");
}

function openPfsenseEditor(id) {
  const editor = document.getElementById("pfsenseEditor");
  editor.style.display = "block";
  document.getElementById("pfsenseTestResult").textContent = "";
  document.getElementById("pfsenseInterfacesBox").innerHTML = "";
  populatePfsenseSiteOptions();
  if (id === null) {
    PFSENSE_EDIT_SELECTED = new Set();
    document.getElementById("pf_id").value = "";
    document.getElementById("pf_name").value = "";
    document.getElementById("pf_site").value = "";
    document.getElementById("pf_base_url").value = "";
    document.getElementById("pf_api_key").value = "";
    document.getElementById("pf_verify_tls").checked = true;
    document.getElementById("pf_enabled").checked = true;
    document.getElementById("pf_poll_minutes").value = 20;
  } else {
    const inst = PFSENSE_CACHE.find(i => i.id === id);
    if (!inst) return;
    PFSENSE_EDIT_SELECTED = new Set(inst.selected_interfaces || []);
    document.getElementById("pf_id").value = inst.id;
    document.getElementById("pf_name").value = inst.name;
    document.getElementById("pf_site").value = inst.site || "";
    document.getElementById("pf_base_url").value = inst.base_url;
    document.getElementById("pf_api_key").value = "";
    document.getElementById("pf_verify_tls").checked = !!inst.verify_tls;
    document.getElementById("pf_enabled").checked = !!inst.enabled;
    document.getElementById("pf_poll_minutes").value = inst.poll_minutes;
    if (PFSENSE_EDIT_SELECTED.size) loadPfsenseInterfacesInto(id);
  }
  editor.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function closePfsenseEditor() {
  document.getElementById("pfsenseEditor").style.display = "none";
}

async function submitPfsenseEditor() {
  const id = document.getElementById("pf_id").value;
  const fields = {
    name: document.getElementById("pf_name").value.trim(),
    site: document.getElementById("pf_site").value,
    base_url: document.getElementById("pf_base_url").value.trim(),
    api_key: document.getElementById("pf_api_key").value,
    verify_tls: document.getElementById("pf_verify_tls").checked,
    enabled: document.getElementById("pf_enabled").checked,
    poll_minutes: parseInt(document.getElementById("pf_poll_minutes").value, 10) || 20,
    selected_interfaces: Array.from(PFSENSE_EDIT_SELECTED),
  };
  const errBox = document.getElementById("pfsenseError");
  errBox.innerHTML = "";
  if (!fields.name || !fields.base_url) {
    errBox.innerHTML = `<div class="error-msg">Name and base URL are required.</div>`;
    return;
  }
  try {
    let saved;
    if (id) {
      // A blank API key field means "keep the current one" -- never
      // overwrite it with an empty value.
      if (!fields.api_key) delete fields.api_key;
      saved = await api(`/api/settings/pfsense/${id}`, { method: "PUT", body: JSON.stringify(fields) });
    } else {
      saved = await api("/api/settings/pfsense", { method: "POST", body: JSON.stringify(fields) });
    }
    showToast("pfSense instance saved");
    await loadPfsenseInstances();
    // Keep editing (now with a real id) so Test connection / interface
    // picking work right after the first save of a new instance.
    openPfsenseEditor(saved.id);
  } catch (e) {
    errBox.innerHTML = `<div class="error-msg">${esc(e.message)}</div>`;
  }
}

async function testPfsenseEditor() {
  const id = document.getElementById("pf_id").value;
  const resultEl = document.getElementById("pfsenseTestResult");
  if (!id) {
    resultEl.textContent = "Save this instance first, then test it.";
    resultEl.style.color = "#dc2626";
    return;
  }
  resultEl.textContent = "Testing…";
  resultEl.style.color = "";
  try {
    await api(`/api/settings/pfsense/${id}/test`, { method: "POST" });
    resultEl.textContent = "Connected";
    resultEl.style.color = "#16a34a";
    await loadPfsenseInterfacesInto(id);
  } catch (e) {
    resultEl.textContent = e.message;
    resultEl.style.color = "#dc2626";
  }
}

async function loadPfsenseInterfacesInto(id) {
  const box = document.getElementById("pfsenseInterfacesBox");
  try {
    const interfaces = await api(`/api/settings/pfsense/${id}/interfaces`);
    if (interfaces.length === 0) {
      box.innerHTML = `<p class="note" style="margin:10px 0;">That instance reported no interfaces.</p>`;
      return;
    }
    box.innerHTML = `<label style="display:block; margin:10px 0 4px; font-size:13px; font-weight:600;">Interfaces/VLANs to pull ARP data from</label>` +
      interfaces.map(iface => `
        <label class="checkbox-field" style="display:flex; margin-bottom:4px;">
          <input type="checkbox" class="pfIfaceCheckbox" value="${esc(iface.name)}" ${PFSENSE_EDIT_SELECTED.has(iface.name) ? "checked" : ""}
            onchange="togglePfsenseInterface(this.value, this.checked)">
          ${esc(iface.label)}
        </label>`).join("");
  } catch (e) {
    box.innerHTML = `<div class="error-msg">${esc(e.message)}</div>`;
  }
}

function togglePfsenseInterface(name, checked) {
  if (checked) PFSENSE_EDIT_SELECTED.add(name);
  else PFSENSE_EDIT_SELECTED.delete(name);
}

async function syncPfsenseNow(id) {
  try {
    await api(`/api/discovery/sync?instance_id=${id}`, { method: "POST" });
    showToast("Synced");
    loadPfsenseInstances();
  } catch (e) { showToast(e.message, true); }
}

async function confirmDeletePfsenseInstance(id, name) {
  if (!confirm(`Delete pfSense instance "${name}"? Its still-pending discovered devices go with it -- anything you've already imported or linked keeps its MAC either way.`)) return;
  try {
    await api(`/api/settings/pfsense/${id}`, { method: "DELETE" });
    showToast("pfSense instance deleted");
    loadPfsenseInstances();
  } catch (e) { showToast(e.message, true); }
}

// --- Backup ---
function doBackup() {
  window.location.href = "/api/backup";
}

// --- Restore ---
async function submitRestore() {
  const fileInput = document.getElementById("f_restoreFile");
  const file = fileInput.files[0];
  const errBox = document.getElementById("restoreError");
  errBox.innerHTML = "";
  if (!file) {
    errBox.innerHTML = `<div class="error-msg">Choose a backup .zip file first.</div>`;
    return;
  }
  if (!confirm("This replaces your existing devices/ports/cables with what's in this backup. This can't be undone. Continue?")) return;
  const formData = new FormData();
  formData.append("file", file);
  try {
    const res = await fetch("/api/restore", { method: "POST", body: formData });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error((body && body.detail) || `request failed (${res.status})`);
    const parts = Object.entries(body.imported || {}).map(([k, v]) => `${v} ${k}`);
    showToast(parts.length ? `Restored: ${parts.join(", ")}` : "Nothing to restore was found in that file");
    fileInput.value = "";
  } catch (e) {
    errBox.innerHTML = `<div class="error-msg">${esc(e.message)}</div>`;
  }
}

// --- Change the signed-in admin's own password ---
async function submitChangeAdminPassword() {
  const current = document.getElementById("pw_current").value;
  const next = document.getElementById("pw_new").value;
  const confirmVal = document.getElementById("pw_confirm").value;
  const errBox = document.getElementById("adminPwError");
  errBox.innerHTML = "";
  if (!current || !next) {
    errBox.innerHTML = `<div class="error-msg">Fill in both your current and new password.</div>`;
    return;
  }
  if (next.length < 8) {
    errBox.innerHTML = `<div class="error-msg">New password must be at least 8 characters.</div>`;
    return;
  }
  if (next !== confirmVal) {
    errBox.innerHTML = `<div class="error-msg">New password and confirmation don't match.</div>`;
    return;
  }
  try {
    await api("/api/account/change-password", {
      method: "POST",
      body: JSON.stringify({ current_password: current, new_password: next }),
    });
    showToast("Password changed");
    document.getElementById("pw_current").value = "";
    document.getElementById("pw_new").value = "";
    document.getElementById("pw_confirm").value = "";
  } catch (e) {
    errBox.innerHTML = `<div class="error-msg">${esc(e.message)}</div>`;
  }
}

// --- Set the viewer account's password (admin override) ---
async function submitSetViewerPassword() {
  const next = document.getElementById("vpw_new").value;
  const confirmVal = document.getElementById("vpw_confirm").value;
  const errBox = document.getElementById("viewerPwError");
  errBox.innerHTML = "";
  if (!next) {
    errBox.innerHTML = `<div class="error-msg">Enter a new password.</div>`;
    return;
  }
  if (next.length < 8) {
    errBox.innerHTML = `<div class="error-msg">New password must be at least 8 characters.</div>`;
    return;
  }
  if (next !== confirmVal) {
    errBox.innerHTML = `<div class="error-msg">New password and confirmation don't match.</div>`;
    return;
  }
  try {
    await api("/api/admin/set-viewer-password", {
      method: "POST",
      body: JSON.stringify({ new_password: next }),
    });
    showToast("Viewer password changed");
    document.getElementById("vpw_new").value = "";
    document.getElementById("vpw_confirm").value = "";
  } catch (e) {
    errBox.innerHTML = `<div class="error-msg">${esc(e.message)}</div>`;
  }
}

// --- Clear all connections ---
async function confirmClearConnections() {
  if (!confirm(
    "This permanently disconnects every cable and wireless/virtual link. Your devices and ports " +
    "themselves are untouched (as are patch-panel pairing and LAG groupings). This cannot be undone. Continue?"
  )) return;
  try {
    await api("/api/admin/clear-connections", { method: "POST" });
    showToast("All connections cleared");
  } catch (e) { showToast(e.message, true); }
}

// --- Reset data ---
async function confirmResetData() {
  const typed = prompt(
    'This permanently deletes every device, port, and cable, and also clears your Sites list and ' +
    'resets Device roles / Interface speeds / Reports shown back to their full default. This cannot be undone.\n\n' +
    'Type RESET to confirm:'
  );
  if (typed !== "RESET") return;
  try {
    await api("/api/admin/reset", { method: "POST" });
    showToast("All data cleared");
  } catch (e) { showToast(e.message, true); }
}

// --- Bootstrap: show nothing until we know who's signed in ---
api("/api/whoami").then(who => {
  if (!who.role) {
    document.getElementById("notSignedIn").style.display = "block";
    return;
  }
  CURRENT_ROLE = who.role;
  document.getElementById("whoamiLine").textContent = who.username ? `Signed in as ${who.username} (${who.role})` : "";
  document.getElementById("settingsWrap").style.display = "block";
  applyRoleVisibility();
  if (isAdmin()) {
    loadSites();
    loadRoleSettings();
    loadSpeedSettings();
    loadReportSettings();
    loadPfsenseInstances();
  }
}).catch(() => {
  document.getElementById("notSignedIn").style.display = "block";
});
