// Shared dark-mode logic for every LinkLedger page (index, settings, help,
// tutorial). Loaded early in <head>, before the page's own content, so a
// saved manual override applies before first paint -- no flash of the
// wrong theme. With no override, the page just follows the OS/browser's
// prefers-color-scheme, which is handled purely by the @media query in
// style.css; this file only needs to persist an explicit override, per
// the "auto by default + manual override" design.
(function () {
  var THEME_KEY = "linkledger-theme";
  try {
    var saved = localStorage.getItem(THEME_KEY);
    if (saved === "light" || saved === "dark") {
      document.documentElement.setAttribute("data-theme", saved);
    }
  } catch (e) {
    // localStorage unavailable (private browsing, disabled storage, etc.)
    // -- just fall back to following the OS/browser preference.
  }
})();

// Resolves to "light" or "dark": whichever is actually in effect right
// now, whether that's from an explicit override or from the OS/browser
// preference.
function currentEffectiveTheme() {
  var explicit = document.documentElement.getAttribute("data-theme");
  if (explicit === "light" || explicit === "dark") return explicit;
  return (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) ? "dark" : "light";
}

// Flips whichever theme is currently in effect and pins it as an explicit,
// persisted override (see the .theme-toggle button in each page).
function toggleTheme() {
  var next = currentEffectiveTheme() === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  try { localStorage.setItem("linkledger-theme", next); } catch (e) {}
}
