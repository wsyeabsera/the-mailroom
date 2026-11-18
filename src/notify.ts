// Outgoing calls from the Hub: the job-done callback (#2775) and the phone push when a job needs approval (#2779).
// Kept out of hub.ts: the Hub only calls check/attach/jobEnded/needsApproval. Neither call can change a job; failures become events.
import { buildCallbackBody, callbackAtSubmit, deliverCallback, FINAL_STATES } from "../shared/callback.ts";
import type { Contract } from "../shared/contract.ts";
import type { Sql } from "./login-limit.ts";

export interface NotifyEnv {
  /** Worker secret: signs callback bodies (HMAC-SHA256). Unset: a job with callback_url is refused at submit (422). */
  CALLBACK_SECRET?: string;
  /** Worker secret: a ntfy-compatible topic URL (https). Unset: no push. */
  PUSH_URL?: string;
  /** Test-only: "1" lets callback and push URLs be http and local. Never set in production. */
  MAILROOM_ALLOW_LOCAL_URLS?: string;
}

const ascii = (s: string, max: number) => s.replace(/[^\x20-\x7E]/g, "?").slice(0, max);

/** The push text. Only the task name, the key label and the approval link: never args or file content. Header-safe (ASCII). */
export function buildPush(task: string, keyLabel: string | null, origin: string): { title: string; body: string; click: string } {
  const click = `${origin}/#/approvals`;
  return { title: ascii(`Mailroom: ${task} needs approval`, 100), body: ascii(`${task} from ${keyLabel ?? "a key"}. Open ${click}`, 300), click };
}

export class Notifier {
  private sql: Sql;
  private env: NotifyEnv;
  private event: (kind: string, payload: Record<string, unknown>) => unknown;
  private waitUntil: (p: Promise<unknown>) => void;
  constructor(sql: Sql, env: NotifyEnv, event: (kind: string, payload: Record<string, unknown>) => unknown, waitUntil: (p: Promise<unknown>) => void) {
    this.sql = sql; this.env = env; this.event = event; this.waitUntil = waitUntil;
    sql.run("CREATE TABLE IF NOT EXISTS job_callbacks (job_id TEXT PRIMARY KEY, url TEXT NOT NULL, origin TEXT NOT NULL)");
  }
  private local = () => ({ allowLocal: this.env.MAILROOM_ALLOW_LOCAL_URLS === "1" });

  /** At submit: the normalised url (or null when none was asked for), or the 422 field error. */
  check(raw: unknown, contract: Contract): { url: string | null } | { error: string } {
    const r = callbackAtSubmit(raw, contract.callbackUrls ?? [], !!this.env.CALLBACK_SECRET, this.local());
    return r.ok ? { url: r.url } : { error: r.reason };
  }
  attach(jobId: string, url: string | null, origin: string) {
    if (url) this.sql.run("INSERT OR REPLACE INTO job_callbacks (job_id, url, origin) VALUES (?, ?, ?)", jobId, url, origin);
  }

  /** Called after any state change. Sends the callback once, when the job reaches a final state. */
  jobEnded(job: Record<string, any>, state: string) {
    if (!(FINAL_STATES as readonly string[]).includes(state)) return;
    const cb = this.sql.all<{ url: string; origin: string }>("SELECT url, origin FROM job_callbacks WHERE job_id = ?", job.id)[0];
    if (!cb) return;
    this.sql.run("DELETE FROM job_callbacks WHERE job_id = ?", job.id);
    const secret = this.env.CALLBACK_SECRET;
    if (!secret) { this.event("callback.failed", { job_id: job.id, attempts: 0, error: "CALLBACK_SECRET is not set" }); return; }
    const row = this.sql.all<Record<string, any>>("SELECT reason, result FROM jobs WHERE id = ?", job.id)[0];
    let result: unknown = null;
    try { result = row?.result == null ? null : JSON.parse(row.result); } catch {}
    const body = buildCallbackBody({ id: job.id, state, reason: row?.reason, result }, `${cb.origin}/api/jobs/${job.id}`);
    this.waitUntil((async () => {
      const r = await deliverCallback({ url: cb.url, body, secret, fetch: (u, i) => fetch(u, i), sleep: (ms) => new Promise((res) => setTimeout(res, ms)) });
      if (!r.ok) this.event("callback.failed", { job_id: job.id, attempts: r.attempts, error: r.error });
    })());
  }

  /** One push per job that enters waiting_approval. No PUSH_URL: nothing happens. */
  needsApproval(job: Record<string, any>, keyLabel: string | null, origin: string) {
    const raw = this.env.PUSH_URL;
    if (!raw) return;
    this.waitUntil((async () => {
      try {
        const url = new URL(raw);
        if (url.protocol !== "https:" && !(this.local().allowLocal && url.protocol === "http:")) throw new Error("PUSH_URL must be https");
        const p = buildPush(job.task, keyLabel, origin);
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), 5000);
        try {
          const res = await fetch(url.href, { method: "POST", redirect: "manual", signal: ctl.signal, headers: { Title: p.title, Click: p.click, Tags: "inbox_tray", "content-type": "text/plain; charset=utf-8" }, body: p.body });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
        } finally { clearTimeout(t); }
      } catch (e) {
        this.event("push.failed", { job_id: job.id, error: e instanceof Error ? e.message.slice(0, 100) : "failed" });
      }
    })());
  }
}
