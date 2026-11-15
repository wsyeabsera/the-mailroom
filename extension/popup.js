import { getHub, fetchState } from "./storage.js";
import { el, renderNeeds, renderEvents, renderChip, renderCounts, openHub } from "./view.js";

const main = document.getElementById("main");
const chip = document.getElementById("chip");
let hub = null;

function message(text, label, onClick) {
  const box = el("div", "message");
  box.append(el("p", null, text));
  const b = el("button", "primary", label);
  b.type = "button";
  b.addEventListener("click", onClick);
  box.append(b);
  main.replaceChildren(box);
  chip.replaceChildren();
  chip.className = "";
}

async function load() {
  main.replaceChildren(el("div", "skel"), el("div", "skel"), el("div", "skel"));
  hub = await getHub();
  const r = await fetchState(hub);
  if (r.kind === "unconfigured") return message("Set the address of your Hub to get started.", "Open settings", () => chrome.runtime.openOptionsPage());
  if (r.kind === "signed_out") return message("You are signed out.", "Sign in", () => chrome.tabs.create({ url: `${hub}/login.html` }));
  if (r.kind === "error") return message(r.message + ".", "Retry", load);
  renderChip(chip, r.state);
  const counts = el("section"); counts.append(el("h2", null, "Today"));
  const cg = el("div", "counts"); renderCounts(cg, r.state); counts.append(cg);
  const needs = el("section"); needs.append(el("h2", null, "Needs you"));
  const nl = el("div"); renderNeeds(nl, r.state, hub); needs.append(nl);
  const ev = el("section"); ev.append(el("h2", null, "Latest"));
  const el2 = el("div"); renderEvents(el2, r.state, 5); ev.append(el2);
  main.replaceChildren(counts, needs, ev);
}

document.getElementById("open").addEventListener("click", async () => { if (hub) await openHub(hub); else chrome.runtime.openOptionsPage(); window.close(); });
document.getElementById("settings").addEventListener("click", () => { chrome.runtime.openOptionsPage(); window.close(); });
document.getElementById("panel").addEventListener("click", async () => {
  const win = await chrome.windows.getCurrent();
  await chrome.sidePanel.open({ windowId: win.id });
  window.close();
});
load();
