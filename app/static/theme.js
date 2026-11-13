// Applies a saved theme override, if any.
(function () {
  var THEME_KEY = "linkledger-theme";
  try {
    var saved = localStorage.getItem(THEME_KEY);
    if (saved === "light" || saved === "dark") {
      document.documentElement.setAttribute("data-theme", saved);
    }
  } catch (e) {
  }
})();

// Returns the theme currently in effect.
function currentEffectiveTheme() {
  var explicit = document.documentElement.getAttribute("data-theme");
  if (explicit === "light" || explicit === "dark") return explicit;
  return (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) ? "dark" : "light";
}

// Toggles the theme and saves it as an explicit override.
function toggleTheme() {
  var next = currentEffectiveTheme() === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  try { localStorage.setItem("linkledger-theme", next); } catch (e) {}
}
