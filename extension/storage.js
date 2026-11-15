// Shared helpers that touch chrome.* (used by popup, side panel, background).
import { parseHubUrl } from "./lib.js";

export async function getHub() {
  const { hub } = await chrome.storage.sync.get("hub");
  return hub && parseHubUrl(hub).ok ? hub : null;
}

/** Fetch /admin/state. Returns {kind:"ok",state} | {kind:"signed_out"} | {kind:"unconfigured"} | {kind:"error",message}. */
export async function fetchState(hub, timeoutMs = 8000) {
  if (!hub) return { kind: "unconfigured" };
  // A stalled network must not leave "Checking..." on screen forever.
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${hub}/admin/state`, { credentials: "include", redirect: "manual", headers: { accept: "application/json" }, signal: ctl.signal });
    if (res.status === 401 || res.status === 403 || res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) return { kind: "signed_out" };
    if (!res.ok) return { kind: "error", message: `Hub answered ${res.status}` };
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("json")) return { kind: "signed_out" }; // login page served instead
    return { kind: "ok", state: await res.json() };
  } catch (e) {
    if (ctl.signal.aborted) return { kind: "error", message: `No answer from the Hub after ${Math.round(timeoutMs / 1000)} s. Check the address and your connection.` };
    return { kind: "error", message: "Cannot reach the Hub. Is the address right, and is access to it allowed for this extension?" };
  } finally {
    clearTimeout(timer);
  }
}
