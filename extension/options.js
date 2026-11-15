import { parseHubUrl } from "./lib.js";
import { fetchState } from "./storage.js";

const input = document.getElementById("hub");
const msg = document.getElementById("msg");
const status = document.getElementById("status");

async function showStatus(hub) {
  status.hidden = false;
  status.textContent = "Checking...";
  const r = await fetchState(hub);
  status.textContent = r.kind === "ok" ? "Connected as owner" : r.kind === "signed_out" ? "Signed out. Sign in on the Hub, then reopen the popup." : r.message;
}

document.getElementById("form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  msg.textContent = "";
  const p = parseHubUrl(input.value);
  if (!p.ok) { msg.textContent = p.error; msg.className = "err"; return; }
  const granted = await chrome.permissions.request({ origins: [p.pattern] });
  if (!granted) { msg.textContent = "Permission to reach that address was not granted."; msg.className = "err"; return; }
  await chrome.storage.sync.set({ hub: p.origin });
  input.value = p.origin;
  msg.className = "muted"; msg.textContent = "Saved.";
  await showStatus(p.origin);
});

const { hub } = await chrome.storage.sync.get("hub");
if (hub) { input.value = hub; showStatus(hub); }
