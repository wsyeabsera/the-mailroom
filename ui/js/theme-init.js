// Runs before first paint (loaded synchronously in <head>): resolve the saved theme and set it on <html>.
(function () {
  var pref = "system";
  try { pref = localStorage.getItem("mr-theme") || "system"; } catch (e) {}
  var dark = window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches;
  var t = pref === "light" || pref === "dark" ? pref : dark ? "dark" : "light";
  document.documentElement.setAttribute("data-theme", t);
})();
