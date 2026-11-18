// mailroom-client: submit parcels to a Mailroom Hub and follow them. Dependency-free; only fetch.
// Works in Node 18+ and in a Cloudflare Worker.
//   const mr = createClient({ url: "https://hub.example.workers.dev", key: env.MAILROOM_KEY });
//   const { id } = await mr.submit("run", { command: "tvdash-scan", args: {} });
//   const job = await mr.wait(id, { onProgress: p => console.log(p.text, p.pct) });
// Cancel is POST /api/jobs/:id/cancel.

export const TERMINAL = ["done", "failed", "refused", "expired", "cancelled"];

export class MailroomError extends Error {
  constructor(message, { status, code, body } = {}) {
    super(message);
    this.name = "MailroomError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

/** @param {{ url?: string, key?: string, fetch?: typeof fetch }} [o] */
export function createClient({ url, key, fetch: f = globalThis.fetch } = {}) {
  if (!url || !key) throw new TypeError("createClient needs { url, key }");
  const base = String(url).replace(/\/+$/, "");
  const call = async (method, path, body, extra = {}) => {
    const res = await f(base + path, {
      method,
      headers: { authorization: `Bearer ${key}`, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...extra },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch {}
    return { res, data };
  };
  const fail = ({ res, data }) => new MailroomError(data?.reason || data?.message || data?.error || `HTTP ${res.status}`, { status: res.status, code: data?.error, body: data });

  // Send a parcel. `label` (1-60 chars, optional) tags it, e.g. "test". `idempotency` makes a repeat within 24 h return the same parcel. `callbackUrl` asks the Hub to POST the result there when the job ends (it must match the contract's callbackUrls). A refused parcel (403) resolves with state "refused" and a reason rather than throwing.
  async function submit(task, args = {}, { idempotency, label, callbackUrl } = {}) {
    const r = await call("POST", "/api/jobs", { task, args, ...(label !== undefined ? { label } : {}), ...(callbackUrl ? { callback_url: callbackUrl } : {}) }, idempotency ? { "idempotency-key": idempotency } : {});
    if (r.res.ok || (r.res.status === 403 && r.data?.state === "refused")) return r.data;
    throw fail(r);
  }
  async function get(jobId) {
    const r = await call("GET", `/api/jobs/${encodeURIComponent(jobId)}`);
    if (!r.res.ok) throw fail(r);
    return r.data; // {id, state, label?, reason?, result?, progress?: {text, pct?}, created_at, updated_at}
  }
  // Poll until a finished state. Rejects on timeout (the parcel keeps going; cancel it if you must).
  /** @param {string} jobId @param {{ onProgress?: (p: { text: string, pct?: number }) => void, intervalMs?: number, timeoutMs?: number }} [o] */
  async function wait(jobId, { onProgress, intervalMs = 1000, timeoutMs = 300000 } = {}) {
    const end = Date.now() + timeoutMs;
    let last;
    for (;;) {
      const job = await get(jobId);
      const p = job.progress;
      if (p && onProgress && JSON.stringify(p) !== last) { last = JSON.stringify(p); onProgress(p, job); }
      if (TERMINAL.includes(job.state)) return job;
      if (Date.now() + intervalMs > end) throw new MailroomError(`timed out waiting for ${jobId} (state ${job.state})`, { code: "timeout", body: job });
      await new Promise(r => setTimeout(r, intervalMs));
    }
  }
  async function cancel(jobId) {
    const r = await call("POST", `/api/jobs/${encodeURIComponent(jobId)}/cancel`, {});
    if (!r.res.ok) throw fail(r);
    return r.data;
  }
  // Submit a registered command (task "run") and wait. Throws unless the job ends "done"; returns its result: { output, exitCode }. output is already parsed JSON when the command is registered with output: "json", else stdout text.
  async function run(command, args = {}, opts = {}) {
    const sub = await submit("run", { command, args }, opts);
    if (sub.state === "refused") throw new MailroomError(sub.reason || "refused", { status: 403, code: "refused", body: sub });
    const job = await wait(sub.id, opts);
    if (job.state !== "done") throw new MailroomError(job.reason || `job ${job.state}`, { code: job.state, body: job });
    return job.result;
  }
  // Ask a registered prompt (task "ask") with variables and wait. The laptop fixes the prompt, tools, turns and model; you pass only vars (and optionally resume: an earlier ask job's id). Throws unless the job ends "done"; returns its result: { output } where output is the parsed JSON when the prompt has a schema, else text.
  async function ask(prompt, vars = {}, opts = {}) {
    const { resume, ...rest } = opts;
    const sub = await submit("ask", { prompt, vars, ...(resume ? { resume } : {}) }, rest);
    if (sub.state === "refused") throw new MailroomError(sub.reason || "refused", { status: 403, code: "refused", body: sub });
    const job = await wait(sub.id, rest);
    if (job.state !== "done") throw new MailroomError(job.reason || `job ${job.state}`, { code: job.state, body: job });
    return job.result;
  }
  return { submit, get, wait, cancel, run, ask };
}
