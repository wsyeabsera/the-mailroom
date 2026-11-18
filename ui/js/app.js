// Hash-routed shell: left rail, top bar, and one module per page in pages/.
import { h, mount } from "./dom.js";
import { api } from "./api.js";
import { themeSwitch } from "./theme.js";

// Top level: Projects, Laptop, Tokens, Docs. Everything older lives under the "All" menu (its routes keep working).
const NAV = [["projects", "Projects"], ["laptop", "Laptop"], ["tokens", "Tokens"]];
const ALL = [["parcels", "Parcels"], ["keys", "Keys"], ["contracts", "Contracts"], ["approvals", "Approvals"], ["events", "Events"]];
const TITLES = { overview: "Overview", projects: "Projects", parcels: "Parcels", approvals: "Approvals", keys: "Keys", contracts: "Contracts", tokens: "Tokens", laptop: "Laptop", events: "Events" };
const PAGES = {
  overview: () => import("./pages/overview.js"), projects: () => import("./pages/projects.js"), parcels: () => import("./pages/parcels.js"), approvals: () => import("./pages/approvals.js"),
  keys: () => import("./pages/keys.js"), contracts: () => import("./pages/contracts.js"), tokens: () => import("./pages/tokens.js"), events: () => import("./pages/events.js"), laptop: () => import("./pages/laptop.js"),
};

const UNASSIGNED_ID = "unassigned";
const rail = document.getElementById("rail");
const top = document.getElementById("top");
const main = document.getElementById("main");
let cleanup = null;
let flashMsg = null;
let token = 0;

// ---- context handed to pages
export const ctx = {
  go: (hash) => { location.hash = hash; },
  flash: (kind, text) => { flashMsg = { kind, text }; },
  takeFlash: () => { const f = flashMsg; flashMsg = null; return f; },
  refresh: () => refreshState(),
};

// ---- rail
const badge = h("i", { class: "badge", hidden: true });
const allBadge = h("i", { class: "badge", hidden: true });
const lapDot = h("span", { class: "dot w" });
const lapText = h("span", null, "Laptop…");
const links = {};
const navLink = ([key, label]) => (links[key] = h("a", { href: "#/" + key }, label, key === "approvals" ? badge : null));
const allMenu = h("details", { id: "all-menu" },
  h("summary", null, h("span", null, "All"), allBadge),
  h("nav", { "aria-label": "All sections" }, ALL.map(navLink)));
rail.append(
  h("div", { class: "brand" }, h("div", { class: "mark", "aria-hidden": "true" }, "M"), "The Mailroom"),
  h("nav", { "aria-label": "Main" }, NAV.map(navLink), h("a", { href: "/docs/" }, "Docs"), allMenu),
  h("div", { class: "sp" }),
  h("a", { class: "lap", href: "#/laptop" }, lapDot, lapText));

export async function refreshState() {
  try {
    const s = await api("/admin/state");
    for (const b of [badge, allBadge]) {
      b.textContent = s.approvals;
      b.hidden = !s.approvals;
      b.setAttribute("aria-label", `${s.approvals} waiting`);
    }
    lapDot.className = "dot" + (s.daemon.connected ? "" : " w");
    lapText.textContent = s.daemon.connected ? "Laptop connected" : "Laptop away";
    return s;
  } catch { return null; }
}
// Keep the rail fresh: every 5 s while the tab is visible, and straight away when it comes back or the window gets focus.
setInterval(() => { if (document.visibilityState === "visible") refreshState(); }, 5000);
window.addEventListener("focus", refreshState);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") refreshState(); });

// ---- top bar
const crumb = h("span");
const signout = h("button", { class: "linkbtn", type: "button", onclick: async () => {
  try { await api("/admin/logout", { method: "POST" }); } catch { /* go anyway */ }
  location.replace("/login.html");
} }, "Sign out");
top.append(crumb, h("span", { class: "top-r" }, themeSwitch(), signout));

function setCrumb(section, detail) {
  mount(crumb, detail ? [TITLES[section] + " / ", h("b", null, detail)] : h("b", null, TITLES[section]));
}

// ---- router
async function route() {
  const my = ++token;
  if (cleanup) { try { cleanup(); } catch { /* ignore */ } cleanup = null; }
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  const section = PAGES[parts[0]] ? parts[0] : "projects";
  if (!parts.length) { location.replace("#/projects"); return; }
  for (const [k, a] of Object.entries(links)) { if (k === section) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); }
  if (ALL.some(([k]) => k === section)) allMenu.open = true;
  setCrumb(section, parts[1] === "new" ? "New" : parts[1] === UNASSIGNED_ID ? "Unassigned" : parts[1]);
  document.title = `${TITLES[section]} · The Mailroom`;
  const view = h("div");
  mount(main, view);
  try {
    const mod = await PAGES[section]();
    if (my !== token) return;
    cleanup = (await mod.render(view, parts.slice(1), ctx)) || null;
    if (my !== token && cleanup) { cleanup(); cleanup = null; }
  } catch (err) {
    console.error(err);
    mount(view, h("div", { class: "bn err", role: "alert" }, "This page failed to load."));
  }
  if (my === token) window.scrollTo(0, 0);
}
window.addEventListener("hashchange", () => { route(); refreshState(); });
refreshState();
route();
