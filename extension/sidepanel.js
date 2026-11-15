import { getHub, fetchState } from "./storage.js";
import { el, renderNeeds, renderEvents, renderChip, openHub } from "./view.js";

const main = document.getElementById("main");
const chip = document.getElementById("chip");
let hub = null;

async function load() {
  hub = await getHub();
  const r = await fetchState(hub);
  if (r.kind !== "ok") {
    const box = el("div", "message");
    const text = r.kind === "unconfigured" ? "Set the Hub URL in Settings." : r.kind === "signed_out" ? "You are signed out." : r.message + ".";
    box.append(el("p", null, text));
    if (r.kind === "signed_out") {
      const b = el("button", "primary", "Sign in"); b.type = "button";
      b.addEventListener("click", () => chrome.tabs.create({ url: `${hub}/login.html` }));
      box.append(b);
    }
    main.replaceChildren(box); chip.replaceChildren(); chip.className = ""; return;
  }
  renderChip(chip, r.state);
  const needs = el("section"); needs.append(el("h2", null, "Needs you"));
  const nl = el("div"); renderNeeds(nl, r.state, hub); needs.append(nl);
  const ev = el("section"); ev.append(el("h2", null, "Latest"));
  const el2 = el("div"); renderEvents(el2, r.state, 5); ev.append(el2);
  main.replaceChildren(needs, ev);
}
document.getElementById("open").addEventListener("click", () => hub ? openHub(hub) : chrome.runtime.openOptionsPage());
document.getElementById("settings").addEventListener("click", () => chrome.runtime.openOptionsPage());
load();
setInterval(load, 15000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) load(); });
