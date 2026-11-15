// DOM rendering shared by popup and side panel. Text is set with textContent only.
import { laptopChip, countsModel, needsYouModel, eventsModel } from "./lib.js";
import { approvalsUrl } from "./lib.js";

export function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

export function renderNeeds(container, state, hub, opts = {}) {
  container.replaceChildren();
  const items = needsYouModel(state.needs_you);
  if (!items.length) { container.append(el("p", "empty", "Nothing waiting for you.")); return; }
  for (const it of items) {
    const row = el("div", "parcel");
    const main = el("div", "parcel-main");
    main.append(el("span", "mono", it.id), el("span", "task", it.task));
    if (it.keyLabel) main.append(el("span", "muted keylabel", it.keyLabel));
    const btn = el("button", "primary", "Review");
    btn.type = "button";
    btn.addEventListener("click", () => chrome.tabs.create({ url: approvalsUrl(hub, it.id) }));
    row.append(main, btn);
    container.append(row);
  }
}

export function renderEvents(container, state, limit = 5) {
  container.replaceChildren();
  const evs = eventsModel(state.latest_events, limit);
  if (!evs.length) { container.append(el("p", "empty", "No events yet.")); return; }
  for (const e of evs) {
    const row = el("div", "event");
    row.append(el("span", "ev-text", e.text), el("span", "muted ev-time", e.time));
    container.append(row);
  }
}

export function renderChip(container, state) {
  const c = laptopChip(state.daemon);
  container.className = "chip " + (c.connected ? "ok" : "away");
  container.replaceChildren(el("span", "dot"), el("span", null, c.label));
  if (c.detail) container.append(el("span", "muted", c.detail));
}

export function renderCounts(container, state) {
  container.replaceChildren();
  for (const c of countsModel(state.counts)) {
    const cell = el("div", "count" + (c.primary && c.value > 0 ? " hot" : ""));
    cell.append(el("b", null, String(c.value)), el("span", null, c.label));
    container.append(cell);
  }
}

export async function openHub(hub) {
  const tabs = await chrome.tabs.query({ url: hub + "/*" });
  if (tabs.length) {
    await chrome.tabs.update(tabs[0].id, { active: true });
    await chrome.windows.update(tabs[0].windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: hub + "/" });
  }
}
