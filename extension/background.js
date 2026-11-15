import { computeBadge, detectNewParcels, approvalsUrl } from "./lib.js";
import { getHub, fetchState } from "./storage.js";

const ALARM = "mailroom-poll";

async function ensureAlarm() {
  const a = await chrome.alarms.get(ALARM);
  if (!a) chrome.alarms.create(ALARM, { periodInMinutes: 0.5, delayInMinutes: 0.1 });
}

async function applyBadge(result) {
  const b = computeBadge(result);
  await chrome.action.setBadgeText({ text: b.text });
  await chrome.action.setBadgeBackgroundColor({ color: b.color });
  await chrome.action.setTitle({ title: b.title });
}

async function poll() {
  const hub = await getHub();
  const result = await fetchState(hub);
  await applyBadge(result);
  if (result.kind !== "ok") return;
  const store = chrome.storage.session;
  const got = await store.get(["seen", "primed"]);
  const firstPoll = !got.primed;
  const { notify, seen } = detectNewParcels(result.state.needs_you, got.seen, firstPoll);
  await store.set({ seen, primed: true });
  for (const id of notify) {
    chrome.notifications.create(`parcel:${id}`, {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: "The Mailroom",
      message: `${id} is waiting for your approval`,
      priority: 1,
    });
  }
}

chrome.runtime.onInstalled.addListener(async (d) => {
  // Fresh install: prime silently so existing parcels do not all notify.
  if (d.reason === "install") await chrome.storage.session.remove(["seen", "primed"]);
  await ensureAlarm();
  poll();
});
chrome.runtime.onStartup.addListener(() => { ensureAlarm(); poll(); });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === ALARM) poll(); });
chrome.storage.onChanged.addListener((ch, area) => {
  if (area === "sync" && ch.hub) { chrome.storage.session.remove(["seen", "primed"]).then(poll); }
});
chrome.runtime.onMessage.addListener((msg) => { if (msg && msg.type === "poll") poll(); });

chrome.notifications.onClicked.addListener(async (nid) => {
  const hub = await getHub();
  if (!hub) return;
  await chrome.tabs.create({ url: approvalsUrl(hub, null) });
  chrome.notifications.clear(nid);
});
