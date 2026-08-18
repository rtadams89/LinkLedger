// ---------------------------------------------------------------------------
// Settings page: Backup/Restore, account passwords, and Reset data. This is
// a standalone page (not part of the main SPA in app.js -- it has no login
// screen, device grid, etc. of its own), so it carries its own small copies
// of the handful of helpers it needs instead of loading all of app.js.
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
  // .admin-only defaults to display:none in the stylesheet (fail closed) --
  // same convention as the main app.
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
        <button class="btn small" onclick="promptRenameSite(${s.id}, '${esc(s.name).replace(/'/g, "\\'")}')">Rename</button>
        <button class="btn small danger" onclick="confirmDeleteSite(${s.id}, '${esc(s.name).replace(/'/g, "\\'")}')">Delete</button>
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

// --- Set the viewer account's password (admin override, no current password needed) ---
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
    'resets Device roles / Interface speeds back to their full default. This cannot be undone.\n\n' +
    'Type RESET to confirm:'
  );
  if (typed !== "RESET") return;
  try {
    await api("/api/admin/reset", { method: "POST" });
    showToast("All data cleared");
  } catch (e) { showToast(e.message, true); }
}

// --- Bootstrap: figure out who's signed in before showing anything ---
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
  }
}).catch(() => {
  document.getElementById("notSignedIn").style.display = "block";
});
