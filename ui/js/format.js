// Formatting and microcopy helpers. All return plain strings; callers insert them as text.
const pad = (n) => String(n).padStart(2, "0");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function hhmm(ts) { if (!ts) return "never"; const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }
export function hhmmss(ts) { const d = new Date(ts); return `${hhmm(ts)}:${pad(d.getSeconds())}`; }
export function dayMonth(ts) {
  if (!ts) return "never";
  const d = new Date(ts), n = new Date();
  if (d.toDateString() === n.toDateString()) return "today";
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}
export function ago(ts) {
  if (!ts) return "never";
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return dayMonth(ts);
}
export const plural = (n, one, many) => `${n} ${n === 1 ? one : many || one + "s"}`;
export function bytes(s) { return new TextEncoder().encode(typeof s === "string" ? s : "").length; }
export function greeting() {
  const h = new Date().getHours();
  return `Good ${h < 12 ? "morning" : h < 18 ? "afternoon" : "evening"}.`;
}
export function clip(s, n = 80) { s = String(s ?? ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; }

export const STATE_LABEL = { waiting_approval: "waiting approval" };
export const STATE_KIND = { done: "ok", waiting_approval: "wa", refused: "er", failed: "er", expired: "er" };
export const stateLabel = (s) => STATE_LABEL[s] || s;

// What a job wants, as three parts: verb, target, details.
export function describeJob(job) {
  const a = job.args || {};
  switch (job.task) {
    case "write_file": return { verb: "write", target: a.path, meta: `${bytes(a.content)} bytes`, change: `+ ${a.path} · ${bytes(a.content)} bytes` };
    case "read_file": return { verb: "read", target: a.path, meta: "read only", change: `read ${a.path}` };
    case "claude": return { verb: "ask claude in", target: a.cwd, meta: clip(a.prompt, 60), change: `claude in ${a.cwd}: ${clip(a.prompt, 80)}` };
    case "echo": return { verb: "echo", target: clip(a.text, 60), meta: "", change: `echo ${clip(a.text, 80)}` };
    default: return { verb: `run ${job.task}`, target: "", meta: "", change: job.task };
  }
}

// Event -> sentence, deadpan.
export function eventText(ev) {
  const p = ev.payload || {};
  const id = p.job_id;
  switch (ev.kind) {
    case "job.queued": return `${id} was received and queued`;
    case "job.waiting_approval": return `${id} is waiting for your approval`;
    case "job.refused": return `${id} refused${p.reason ? ": " + p.reason : ""}`;
    case "job.approved": return `${id} approved`;
    case "job.declined": return `${id} declined`;
    case "job.running": return `${id} is running`;
    case "job.done": return `${id} done`;
    case "job.failed": return `${id} failed${p.reason ? ": " + p.reason : ""}`;
    case "job.cancelled": return `${id} cancelled`;
    case "key.created": return `Key “${p.label}” created`;
    case "key.revoked": return `Key “${p.label}” revoked`;
    case "contract.saved": return `Contract “${p.name}” saved (version ${p.version})`;
    case "daemon.connected": return "Laptop connected";
    case "daemon.disconnected": return "Laptop disconnected";
    case "daemon.rotated": return "Laptop credential rotated";
    case "token.created": return `Token “${p.label}” created`;
    case "token.revoked": return `Token “${p.label}” revoked`;
    case "callback.failed": return `Callback for ${id} failed after ${p.attempts ?? 0} tries${p.error ? ": " + p.error : ""}`;
    case "push.failed": return `Phone push for ${id} failed${p.error ? ": " + p.error : ""}`;
    case "mcp.call": return `${p.label ?? "A token"} called ${String(p.tool ?? "a tool").replace(/^mailroom_/, "")}${p.ok === false ? " (refused)" : ""}`;
    default: return ev.kind;
  }
}
export function eventTag(ev) {
  const k = ev.kind;
  if (k === "callback.failed" || k === "push.failed") return [k.split(".")[0], "er"];
  if (k === "job.waiting_approval") return ["approval", "wa"];
  if (k === "job.refused" || k === "job.declined" || k === "job.failed") return [k.slice(4), "er"];
  if (k === "job.done") return ["done", "ok"];
  if (k.startsWith("job.")) return [k.slice(4).replace("_", " "), ""];
  return [k.split(".")[0], ""];
}

export const TASK_WORDS = { echo: "echo", read_file: "read", write_file: "write", claude: "ask claude", run: "run a command", mcp_list: "list laptop tools", mcp_call: "call laptop tools" };
export function joinWords(list) {
  if (list.length <= 1) return list.join("");
  return list.slice(0, -1).join(", ") + " and " + list[list.length - 1];
}
export function expiryText(iso) { return iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "never"; }
