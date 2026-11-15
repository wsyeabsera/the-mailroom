// Pure logic for The Mailroom extension. No chrome.* calls here.

export const COLORS = { stamp: "#f2703a", amber: "#e0a030", grey: "#6b7280" };

/** Validate a Hub URL: http(s), no path/query/hash/credentials. Returns {ok, origin, pattern} or {ok:false, error}. */
export function parseHubUrl(input) {
  const raw = String(input ?? "").trim();
  if (!raw) return { ok: false, error: "Enter the Hub URL." };
  let u;
  try { u = new URL(raw); } catch { return { ok: false, error: "That is not a valid URL." }; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return { ok: false, error: "Use http:// or https://." };
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol === "http:" && !local) return { ok: false, error: "Plain http is only allowed for localhost." };
  if (u.username || u.password) return { ok: false, error: "Do not put a login in the URL." };
  if ((u.pathname !== "/" && u.pathname !== "") || u.search || u.hash) return { ok: false, error: "Use the bare address, with no path." };
  return { ok: true, origin: u.origin, pattern: `${u.protocol}//${u.hostname}/*` };
}

/** Reduce a /admin/state result (or a failure) to the badge. */
export function computeBadge(result) {
  if (!result || result.kind === "unconfigured") return { text: "", color: COLORS.grey, title: "The Mailroom: set the Hub URL in Settings" };
  if (result.kind === "signed_out") return { text: "x", color: COLORS.grey, title: "The Mailroom: signed out" };
  if (result.kind === "error") return { text: "?", color: COLORS.grey, title: "The Mailroom: cannot reach the Hub" };
  const s = result.state || {};
  const n = approvalCount(s);
  const connected = !!(s.daemon && s.daemon.connected);
  // The count is the actionable part (approvals work while the laptop is away), so it wins; amber says the laptop is away.
  if (n > 0) {
    return {
      text: n > 99 ? "99+" : String(n),
      color: connected ? COLORS.stamp : COLORS.amber,
      title: `The Mailroom: ${n} waiting for your approval${connected ? "" : " (laptop is out to lunch)"}`,
    };
  }
  if (!connected) return { text: "!", color: COLORS.amber, title: "The Mailroom: laptop is out to lunch" };
  return { text: "", color: COLORS.stamp, title: "The Mailroom: nothing waiting for you" };
}

export function approvalCount(state) {
  if (!state) return 0;
  if (Number.isFinite(state.approvals)) return state.approvals;
  return Array.isArray(state.needs_you) ? state.needs_you.length : 0;
}

/** Which parcels should raise a notification? Returns {notify:[ids], seen:[ids]}. firstPoll => never notify. */
export function detectNewParcels(needsYou, seenIds, firstPoll) {
  const ids = (Array.isArray(needsYou) ? needsYou : []).map((j) => j && j.id).filter((x) => typeof x === "string");
  const seen = new Set(Array.isArray(seenIds) ? seenIds : []);
  const notify = firstPoll ? [] : ids.filter((id) => !seen.has(id));
  // keep only ids still waiting plus newly seen ones, so a parcel that leaves and returns can notify again
  return { notify, seen: ids };
}

export function approvalsUrl(hub, id) {
  return id ? `${hub}/#/approvals/${encodeURIComponent(id)}` : `${hub}/#/approvals`;
}

export function relativeTime(ts, now = Date.now()) {
  if (!Number.isFinite(ts)) return "never";
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

export function laptopChip(daemon, now = Date.now()) {
  if (daemon && daemon.connected) return { connected: true, label: "Laptop connected", detail: "" };
  const seen = daemon && Number.isFinite(daemon.last_seen) ? relativeTime(daemon.last_seen, now) : "never";
  return { connected: false, label: "Out to lunch", detail: `last seen ${seen}` };
}

export function countsModel(counts) {
  const c = counts || {};
  const n = (k) => (Number.isFinite(c[k]) ? c[k] : 0);
  return [
    { key: "waiting_approval", label: "Waiting for you", value: n("waiting_approval"), primary: true },
    { key: "queued", label: "Queued", value: n("queued") },
    { key: "running", label: "Running", value: n("running") },
    { key: "done", label: "Done today", value: n("done") },
    { key: "refused", label: "Refused", value: n("refused") },
  ];
}

export function needsYouModel(list) {
  return (Array.isArray(list) ? list : []).map((j) => ({
    id: String(j.id ?? ""),
    task: String(j.task ?? ""),
    keyLabel: String((j.key && j.key.label) || j.key_label || j.label || ""),
  }));
}

const KIND_TEXT = {
  "key.created": "Key created", "key.revoked": "Key revoked", "contract.saved": "Contract saved",
  "job.queued": "queued", "job.waiting_approval": "waiting for approval", "job.refused": "refused",
  "job.approved": "approved", "job.declined": "declined", "job.running": "running", "job.done": "done",
  "job.failed": "failed", "job.cancelled": "cancelled",
  "daemon.connected": "Laptop connected", "daemon.disconnected": "Laptop disconnected", "daemon.rotated": "Laptop credential rotated",
};

export function eventsModel(events, limit = 5, now = Date.now()) {
  return (Array.isArray(events) ? events : []).slice(0, limit).map((e) => {
    const p = (e && e.payload) || {};
    const kind = String((e && e.kind) || "");
    let text = KIND_TEXT[kind] || kind;
    if (kind.startsWith("job.") && p.job_id) text = `${p.job_id} ${text}`;
    else if (kind.startsWith("key.") && p.label) text = `${text}: ${p.label}`;
    else if (kind === "contract.saved" && p.name) text = `${text}: ${p.name}`;
    return { seq: e.seq, text, time: relativeTime(e.ts, now), kind };
  });
}
