// The Hub: the one Durable Object and the only writer. SQLite state, append-only events, SSE replay, the daemon WebSocket.
import { DurableObject } from "cloudflare:workers";
import { check, validateContract, type Contract } from "../shared/contract.ts";
import { cancelAction } from "../shared/cancel.ts";
import { bearer, credentialHint, displayPrefix, generateAdminToken, generateDaemonCredential, generateKey, hashToken, makeId, safeEqual, safeEqualSecret, tokenKind, validateTokenInput } from "./keys.ts";
import { formatFieldErrors, handleMcpText, ToolError, type McpApi } from "./mcp.ts";
import { checkLogin, clearFailures, LOGIN_TABLE, recordFailure, type Sql } from "./login-limit.ts";
import { laneKey, laneOf, parseHello, pickNext, type LaneHints } from "../shared/lanes.ts";
import { ensureProjectSchema, Projects, storePromptReport, storeReport } from "./projects.ts";
import { fingerprint, idempotencyFresh, parseIdempotencyKey } from "./idempotency.ts";
import { isRerunSafe, NOT_RERUN_SAFE_REASON, parseLabel, parseRerunSafe, REQUEUE_REASON, UNCOUNTED_SQL } from "./job-rules.ts";
import { markerBytes, planResult, resultCutoff, resultExpired } from "./results.ts";
import { MAX_RESULT_BYTES } from "../shared/limits.ts";
import { Notifier, type NotifyEnv } from "./notify.ts";
import { SESSION_SECONDS, sessionCookie, signSession } from "./session.ts";

export interface Env extends NotifyEnv {
  HUB: DurableObjectNamespace;
  ASSETS: Fetcher;
  OWNER_PASSWORD?: string;
  SESSION_SECRET?: string;
}

const MAX_BODY = 256 * 1024;
const RATE_PER_MIN = 60;
const MCP_MAX_BODY = 64 * 1024;
const MCP_RATE_PER_MIN = 120;
const TOKEN_TOUCH_MS = 60_000;
const PING_MS = 25_000;
const DEAD_MS = 60_000;
const SSE_PING_MS = 20_000;
const STATES = ["queued", "waiting_approval", "running", "done", "refused", "failed"] as const;

type Row = Record<string, any>;
type Ev = { seq: number; ts: number; kind: string; payload: any };
type Daemon = { ws: WebSocket; hello: boolean; lastPong: number; timer: ReturnType<typeof setInterval> | null; pings: Map<string, () => void> };

const json = (body: unknown, status = 200, headers?: Record<string, string>) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });
const err = (status: number, error: string, extra: Record<string, unknown> = {}) => json({ error, ...extra }, status);
const invalid = (errors: Record<string, string>) => err(422, "invalid", { errors });
const parse = (s: string | null | undefined) => (s == null ? undefined : JSON.parse(s));
const utcMidnight = (now: number) => now - (now % 86_400_000);

export class Hub extends DurableObject<Env> {
  private sql: Sql;
  private notify: Notifier;
  private daemon: Daemon | null = null;
  private inflight = new Map<string, string>(); // lane key -> running job id (see shared/lanes.ts)
  private laneMode: { hints: LaneHints } | null = null; // null = old daemon: one lane
  private lastSeq = 0; // last seq the daemon said it saw
  private subs = new Set<ReadableStreamDefaultController<Uint8Array>>();
  private sseTimer: ReturnType<typeof setInterval> | null = null;
  private rate = new Map<string, { start: number; n: number }>();
  private mcpRate = new Map<string, { start: number; n: number }>();
  private enc = new TextEncoder();
  private projects: Projects;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const s = ctx.storage.sql;
    this.sql = { all: <T>(q: string, ...p: unknown[]) => [...s.exec(q, ...p)] as T[], run: (q: string, ...p: unknown[]) => void s.exec(q, ...p) };
    for (const q of [
      "CREATE TABLE IF NOT EXISTS keys (id TEXT PRIMARY KEY, label TEXT NOT NULL, prefix TEXT NOT NULL, hash TEXT NOT NULL, contract_id TEXT NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER, last_used_at INTEGER)",
      "CREATE TABLE IF NOT EXISTS contracts (id TEXT PRIMARY KEY, name TEXT NOT NULL, body TEXT NOT NULL, version INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
      "CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, key_id TEXT NOT NULL, contract_id TEXT NOT NULL, contract_version INTEGER NOT NULL, task TEXT NOT NULL, args TEXT NOT NULL, state TEXT NOT NULL, reason TEXT, result TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
      "CREATE TABLE IF NOT EXISTS job_progress (job_id TEXT PRIMARY KEY, text TEXT NOT NULL, pct REAL, at INTEGER NOT NULL)",
      "CREATE INDEX IF NOT EXISTS jobs_key ON jobs (key_id, created_at)",
      "CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL)",
      "CREATE TABLE IF NOT EXISTS daemon (id INTEGER PRIMARY KEY CHECK (id = 1), hash TEXT NOT NULL, hint TEXT, rotated_at INTEGER NOT NULL, last_seen INTEGER, connected INTEGER NOT NULL DEFAULT 0)",
      "CREATE TABLE IF NOT EXISTS admin_tokens (id TEXT PRIMARY KEY, label TEXT NOT NULL, prefix TEXT NOT NULL, hash TEXT NOT NULL, scopes TEXT NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER, last_used_at INTEGER)",
      "CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL)",
      "CREATE TABLE IF NOT EXISTS job_results (job_id TEXT PRIMARY KEY, body TEXT NOT NULL, bytes INTEGER NOT NULL, stored_at INTEGER NOT NULL)", // results over 200 KB, kept 7 days
      "CREATE INDEX IF NOT EXISTS job_results_at ON job_results (stored_at)",
      "CREATE TABLE IF NOT EXISTS idempotency (key_id TEXT NOT NULL, idem_key TEXT NOT NULL, job_id TEXT NOT NULL, fp TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (key_id, idem_key))",
      "CREATE TABLE IF NOT EXISTS daemon_rerun (name TEXT PRIMARY KEY)", // commands the laptop flagged re-run-safe in its last hello
      LOGIN_TABLE,
    ])
      this.sql.run(q);
    ensureProjectSchema(this.sql);
    this.projects = new Projects({
      sql: this.sql, next: (n) => this.next(n), event: (k, p) => this.event(k, p), keyOut: (k) => this.keyOut(k), jobOut: (j) => this.jobOut(j),
      progress: (id) => this.progressOf(id), contractBody: (id) => { const c = this.contractRow(id); return c ? (parse(c.body) as Contract) : undefined; }, readJson: (r) => this.readJson(r),
    });
    try { this.sql.run("ALTER TABLE jobs ADD COLUMN label TEXT"); } catch { /* already there */ }
    this.sweepResults();
    this.notify = new Notifier(this.sql, this.env, (k, p) => this.event(k, p), (p) => this.ctx.waitUntil(p)); // callbacks + phone push (src/notify.ts)
    // A fresh instance has no socket: nothing can still be running.
    this.sql.run("UPDATE daemon SET connected = 0");
    for (const j of this.sql.all<Row>("SELECT * FROM jobs WHERE state = 'running'")) this.requeueOrFail(j);
  }

  // ---- small helpers ----
  private one = (q: string, ...p: unknown[]): Row | undefined => this.sql.all<Row>(q, ...p)[0];
  private next(name: string): number {
    this.sql.run("INSERT INTO meta (k, v) VALUES (?, 1) ON CONFLICT (k) DO UPDATE SET v = v + 1", name);
    return this.one("SELECT v FROM meta WHERE k = ?", name)!.v - 1;
  }

  private event(kind: string, payload: Record<string, unknown>): Ev {
    const ts = Date.now();
    this.sql.run("INSERT INTO events (ts, kind, payload) VALUES (?, ?, ?)", ts, kind, JSON.stringify(payload));
    const seq = this.one("SELECT last_insert_rowid() AS s")!.s as number;
    const ev = { seq, ts, kind, payload };
    const frame = this.enc.encode(`id: ${seq}\ndata: ${JSON.stringify(ev)}\n\n`);
    for (const c of this.subs) {
      try {
        c.enqueue(frame);
      } catch {
        this.subs.delete(c);
      }
    }
    return ev;
  }
  private evOut = (r: Row): Ev => ({ seq: r.seq, ts: r.ts, kind: r.kind, payload: parse(r.payload) });
  private lastEventSeq = () => (this.one("SELECT MAX(seq) AS s FROM events")?.s as number | null) ?? 0;

  private jobOut = (r: Row) => ({
    id: r.id, key_id: r.key_id, contract_id: r.contract_id, contract_version: r.contract_version, task: r.task, args: parse(r.args), state: r.state,
    label: r.label ?? undefined, reason: r.reason ?? undefined, result: parse(r.result), progress: this.progressOf(r.id), created_at: r.created_at, updated_at: r.updated_at,
  });
  private progressOf(id: string) {
    const p = this.one("SELECT text, pct, at FROM job_progress WHERE job_id = ?", id);
    return p ? { text: p.text as string, ...(p.pct === null ? {} : { pct: p.pct as number }), at: p.at as number } : undefined;
  }

  /** The job's result in full: a big one is read from job_results (or reported as expired once it has been swept). */
  private resultOf(r: Row): unknown {
    const bytes = markerBytes(r.result);
    if (bytes === null) return parse(r.result);
    const big = this.one("SELECT body, stored_at FROM job_results WHERE job_id = ?", r.id);
    if (!big || resultExpired(big.stored_at, Date.now())) return { expired: true, bytes };
    return parse(big.body);
  }
  /** Removes big results older than 7 days. Runs when the Hub wakes, when a big result is stored and when one is read. */
  private sweepResults() { this.sql.run("DELETE FROM job_results WHERE stored_at < ?", resultCutoff(Date.now())); }

  /** A job that was running when the laptop dropped: queued again if re-running it is safe, otherwise failed. */
  private requeueOrFail(j: Row) {
    const safe = this.sql.all<Row>("SELECT name FROM daemon_rerun").map((r) => r.name as string);
    if (isRerunSafe(j.task, parse(j.args), safe)) this.setState(j, "queued", REQUEUE_REASON);
    else this.setState(j, "failed", NOT_RERUN_SAFE_REASON);
  }

  /** Moves a job to a new state, appends the event. `kind` defaults to job.<state>. */
  private setState(job: Row, state: string, reason?: string | null, result?: unknown, kind?: string) {
    const now = Date.now();
    let stored: string | null = job.result ?? null;
    if (result !== undefined) {
      const plan = planResult(JSON.stringify(result) ?? "null");
      if (plan.kind === "inline") stored = plan.json;
      else if (plan.kind === "stored") {
        this.sql.run("INSERT OR REPLACE INTO job_results (job_id, body, bytes, stored_at) VALUES (?, ?, ?, ?)", job.id, plan.body, plan.bytes, now);
        this.sweepResults();
        stored = plan.marker;
      } else stored = null; // callers check size first; never keep an oversized result
    }
    this.sql.run("UPDATE jobs SET state = ?, reason = ?, result = ?, updated_at = ?, contract_version = ? WHERE id = ?", state, reason ?? null, stored, now, job.contract_version, job.id);
    job.result = stored;
    job.state = state;
    if (state === "queued") this.sql.run("DELETE FROM job_progress WHERE job_id = ?", job.id); // a requeued job starts over
    const p: Record<string, unknown> = { job_id: job.id, key_id: job.key_id, task: job.task };
    if (reason) p.reason = reason;
    this.event(kind ?? `job.${state}`, p);
    this.notify.jobEnded(job, state); // job-done callback, if the job asked for one
  }

  private contractRow(id: string): Row | undefined { return this.one("SELECT * FROM contracts WHERE id = ?", id); }
  private contractOut(r: Row) { return { id: r.id, ...(parse(r.body) as Contract), version: r.version, used_by: this.one("SELECT COUNT(*) AS n FROM keys WHERE contract_id = ? AND revoked_at IS NULL", r.id)!.n }; }

  private usedToday(keyId: string, now: number, excludeId?: string): number {
    return this.one(`SELECT COUNT(*) AS n FROM jobs WHERE key_id = ? AND created_at >= ? AND state NOT IN (${UNCOUNTED_SQL}) AND id != ?`, keyId, utcMidnight(now), excludeId ?? "")!.n;
  }

  private async readJson(req: Request): Promise<{ ok: true; body: any } | { ok: false; res: Response }> {
    const len = Number(req.headers.get("content-length") ?? 0);
    if (len > MAX_BODY) return { ok: false, res: err(413, "too_large") };
    const text = await req.text();
    if (text.length > MAX_BODY || this.enc.encode(text).length > MAX_BODY) return { ok: false, res: err(413, "too_large") };
    try {
      const body = JSON.parse(text);
      if (body === null || typeof body !== "object" || Array.isArray(body)) return { ok: false, res: invalid({ body: "Expected a JSON object." }) };
      return { ok: true, body };
    } catch {
      return { ok: false, res: invalid({ body: "Not valid JSON." }) };
    }
  }

  // ---- routing ----
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    try {
      if (path === "/daemon") return await this.daemonUpgrade(req);
      if (path === "/api/jobs" || path.startsWith("/api/jobs/")) return await this.clientRoute(req, path);
      if (path === "/api/commands") return await this.commandsRoute(req);
      if (path === "/mcp") return await this.mcp(req);
      if (path === "/admin/login") return await this.login(req);
      if (path.startsWith("/admin/")) return await this.admin(req, url);
      return err(404, "not_found");
    } catch (e) {
      console.error("hub error", e instanceof Error ? e.message : "unknown");
      return err(500, "internal");
    }
  }

  // ---- client API ----
  private async clientAuth(req: Request): Promise<Row | null> {
    const tok = bearer(req.headers.get("Authorization"));
    if (!tok || tokenKind(tok) !== "client") return null;
    const hash = await hashToken(tok);
    const k = this.sql.all<Row>("SELECT * FROM keys WHERE prefix = ? AND revoked_at IS NULL", displayPrefix(tok)).find((r) => safeEqual(r.hash, hash));
    if (!k) return null;
    const c = this.contractRow(k.contract_id);
    if (!c) return null;
    const exp = (parse(c.body) as Contract).expires;
    if (exp && Date.now() >= Date.parse(exp)) return null;
    this.sql.run("UPDATE keys SET last_used_at = ? WHERE id = ?", Date.now(), k.id);
    return k;
  }

  private rateLimited(keyId: string, map = this.rate, limit = RATE_PER_MIN): boolean {
    const now = Date.now();
    const r = map.get(keyId);
    if (!r || now - r.start >= 60_000) {
      map.set(keyId, { start: now, n: 1 });
      return false;
    }
    return ++r.n > limit;
  }

  private async commandsRoute(req: Request): Promise<Response> {
    const k = await this.clientAuth(req);
    if (!k) return err(401, "bad_key");
    if (this.rateLimited(k.id)) return err(429, "rate_limited", { retry_after: 60 });
    if (req.method !== "GET") return err(405, "method_not_allowed");
    return json(this.projects.commandsFor((parse(this.contractRow(k.contract_id)!.body) as Contract).commands ?? []));
  }

  private async clientRoute(req: Request, path: string): Promise<Response> {
    const k = await this.clientAuth(req);
    if (!k) return err(401, "bad_key");
    if (this.rateLimited(k.id)) return err(429, "rate_limited", { retry_after: 60 });
    if (path === "/api/jobs") {
      if (req.method !== "POST") return err(405, "method_not_allowed");
      return this.submit(req, k);
    }
    const rest = path.slice("/api/jobs/".length);
    if (rest.endsWith("/cancel")) {
      if (req.method !== "POST") return err(405, "method_not_allowed");
      const cj = this.one("SELECT * FROM jobs WHERE id = ? AND key_id = ?", rest.slice(0, -"/cancel".length), k.id);
      if (!cj) return err(404, "not_found");
      const action = cancelAction(cj.state);
      if (action === "conflict") return err(409, "not_cancellable", { state: cj.state });
      this.setState(cj, "cancelled", "cancelled by client"); // appends job.cancelled
      if (action === "stop") {
        this.clearInflight(cj.id);
        this.send({ type: "cancel", id: cj.id });
      }
      this.pushNext();
      return json({ id: cj.id, state: "cancelled" });
    }
    if (req.method !== "GET") return err(405, "method_not_allowed");
    const j = this.one("SELECT * FROM jobs WHERE id = ? AND key_id = ?", rest, k.id);
    if (!j) return err(404, "not_found");
    const o = this.jobOut(j);
    this.sweepResults();
    return json({ id: o.id, state: o.state, label: o.label, reason: o.reason, result: this.resultOf(j), progress: o.progress, created_at: o.created_at, updated_at: o.updated_at });
  }

  private async submit(req: Request, k: Row): Promise<Response> {
    const r = await this.readJson(req);
    if (!r.ok) return r.res;
    const { task, args = {} } = r.body;
    const errors: Record<string, string> = {};
    const lab = parseLabel(r.body.label);
    if (!lab.ok) errors.label = lab.error;
    const idem = parseIdempotencyKey(req.headers.get("Idempotency-Key"));
    if (idem === "invalid") errors.idempotency_key = "Idempotency-Key must be 1 to 200 printable characters.";
    if (typeof task !== "string" || task.length === 0 || task.length > 40) errors.task = "task must be a string.";
    if (args === null || typeof args !== "object" || Array.isArray(args)) errors.args = "args must be an object.";
    else if (typeof task === "string") {
      if (task === "echo" && typeof args.text !== "string") errors.args = "echo needs a text string.";
      if (task === "write_file" && typeof args.content !== "string") errors.args = "write_file needs a content string.";
      if (task === "claude" && typeof args.prompt !== "string") errors.args = "claude needs a prompt string.";
      if (task === "ask" && typeof args.prompt !== "string") errors.args = "ask needs a prompt name string.";
      if (task === "ask" && args.vars !== undefined && (args.vars === null || typeof args.vars !== "object" || Array.isArray(args.vars))) errors.args = "ask vars must be an object.";
      if (task === "run" && typeof args.command !== "string") errors.args = "run needs a command name string.";
      if (task === "run" && args.args !== undefined && (args.args === null || typeof args.args !== "object" || Array.isArray(args.args))) errors.args = "run args must be an object.";
      if ((task === "read_file" || task === "write_file") && args.path !== undefined && typeof args.path !== "string") errors.args = `${task} needs a path string.`;
      if (task === "claude" && args.cwd !== undefined && typeof args.cwd !== "string") errors.args = "claude needs a cwd string.";
    }
    const c = this.contractRow(k.contract_id)!;
    const cb = this.notify.check(r.body.callback_url, parse(c.body));
    if ("error" in cb) errors.callback_url = cb.error;
    if (Object.keys(errors).length) return invalid(errors);

    const now = Date.now();
    // A repeat of the same Idempotency-Key within 24 h returns the original job instead of making a second one.
    const fp = fingerprint(task, args);
    if (typeof idem === "string") {
      const prev = this.one("SELECT * FROM idempotency WHERE key_id = ? AND idem_key = ?", k.id, idem);
      if (prev && idempotencyFresh(prev.created_at, now)) {
        if (prev.fp !== fp) return err(409, "idempotency_conflict", { message: "This Idempotency-Key was already used with a different task or args." });
        const pj = this.one("SELECT * FROM jobs WHERE id = ?", prev.job_id);
        if (pj) return pj.state === "refused" ? json({ id: pj.id, state: pj.state, reason: pj.reason, idempotent_replay: true }, 403) : json({ id: pj.id, state: pj.state, idempotent_replay: true }, 200);
      }
      this.sql.run("DELETE FROM idempotency WHERE created_at < ?", now - 24 * 3600_000);
    }
    const verdict = check(parse(c.body), { task, args }, { now, usedToday: this.usedToday(k.id, now) });
    const id = makeId("p_", this.next("job"));
    const state = verdict.verdict === "refuse" ? "refused" : verdict.verdict === "approve" ? "waiting_approval" : "queued";
    this.sql.run("INSERT INTO jobs (id, key_id, contract_id, contract_version, task, args, state, reason, result, created_at, updated_at, label) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)",
      id, k.id, c.id, c.version, task, JSON.stringify(args), state, verdict.verdict === "refuse" ? verdict.reason : null, now, now, lab.ok ? lab.label : null);
    if (typeof idem === "string") this.sql.run("INSERT OR REPLACE INTO idempotency (key_id, idem_key, job_id, fp, created_at) VALUES (?, ?, ?, ?, ?)", k.id, idem, id, fp, now);
    const job = this.one("SELECT * FROM jobs WHERE id = ?", id)!;
    this.event(`job.${state}`, { job_id: id, key_id: k.id, task, ...(verdict.verdict === "refuse" ? { reason: verdict.reason } : {}) });
    if (verdict.verdict === "refuse") return json({ id, state, reason: verdict.reason }, 403);
    this.notify.attach(id, "url" in cb ? cb.url : null,new URL(req.url).origin);
    if (state === "waiting_approval") this.notify.needsApproval(job, k.label ?? null, new URL(req.url).origin); // phone push
    if (state === "queued") this.pushNext();
    return json({ id, state }, 202);
  }

  // ---- owner: login ----
  private async login(req: Request): Promise<Response> {
    if (req.method !== "POST") return err(405, "method_not_allowed");
    const { OWNER_PASSWORD, SESSION_SECRET } = this.env;
    if (!OWNER_PASSWORD || !SESSION_SECRET) return err(500, "misconfigured", { message: "OWNER_PASSWORD and SESSION_SECRET must be set." });
    const ip = req.headers.get("X-Mr-IP") || "unknown";
    const a = checkLogin(this.sql, ip);
    if (a.locked) return err(429, "too_many_attempts", { retry_after: a.retry_after });
    const r = await this.readJson(req);
    if (!r.ok) return r.res;
    const pw = typeof r.body.password === "string" ? r.body.password : "";
    if (!(await safeEqualSecret(pw, OWNER_PASSWORD))) {
      const n = recordFailure(this.sql, ip);
      return n.locked ? err(429, "too_many_attempts", { retry_after: n.retry_after }) : err(401, "bad_password", { tries_left: n.tries_left });
    }
    clearFailures(this.sql, ip);
    const exp = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
    const secure = req.headers.get("X-Mr-Secure") === "1";
    return new Response(null, { status: 204, headers: { "Set-Cookie": sessionCookie(await signSession(SESSION_SECRET, exp), SESSION_SECONDS, secure), "cache-control": "no-store" } });
  }

  // ---- owner: everything else (the Worker has verified the session and the Origin) ----
  private async admin(req: Request, url: URL): Promise<Response> {
    const path = url.pathname;
    const m = req.method;
    const seg = path.split("/").filter(Boolean); // ["admin", ...]
    const route = seg[1];

    if (route === "logout" && seg.length === 2) return m === "POST" ? new Response(null, { status: 204, headers: { "Set-Cookie": sessionCookie("", 0, req.headers.get("X-Mr-Secure") === "1") } }) : err(405, "method_not_allowed");
    if (route === "state" && seg.length === 2) return m === "GET" ? this.state() : err(405, "method_not_allowed");

    if (route === "keys") {
      if (seg.length === 2) {
        if (m === "GET") return json(this.sql.all<Row>("SELECT * FROM keys ORDER BY created_at DESC, id DESC").map((k) => this.keyOut(k)));
        if (m === "POST") return this.createKey(req);
        return err(405, "method_not_allowed");
      }
      const k = this.one("SELECT * FROM keys WHERE id = ?", seg[2]);
      if (!k) return err(404, "not_found");
      if (seg.length === 3 && m === "GET") return json(this.keyDetail(k));
      if (seg.length === 3 && m === "PATCH") return this.projects.moveKey(req, k);
      if (seg.length === 4 && seg[3] === "revoke") return m === "POST" ? this.revoke(k) : err(405, "method_not_allowed");
      return err(404, "not_found");
    }

    if (route === "projects") return this.projects.route(req, seg);

    if (route === "contracts") {
      if (seg.length === 2) {
        if (m === "GET") return json(this.sql.all<Row>("SELECT * FROM contracts ORDER BY updated_at DESC, id DESC").map((c) => this.contractOut(c)));
        if (m === "POST") return this.saveContract(req, null);
        return err(405, "method_not_allowed");
      }
      const c = this.contractRow(seg[2]);
      if (seg.length === 3) {
        if (m === "GET") return c ? json(this.contractOut(c)) : err(404, "not_found");
        if (m === "PUT") return c ? this.saveContract(req, c) : err(404, "not_found");
        return err(405, "method_not_allowed");
      }
      return err(404, "not_found");
    }

    if (route === "jobs" || route === "parcels") { // "parcels" is an alias of "jobs"
      if (seg.length === 2) {
        if (m !== "GET") return err(405, "method_not_allowed");
        const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") ?? "50", 10) || 50, 1), 500);
        return json(this.jobList(url.searchParams.get("state"), limit, url.searchParams.get("label")));
      }
      const j = this.one("SELECT * FROM jobs WHERE id = ?", seg[2]);
      if (!j) return err(404, "not_found");
      if (seg.length === 3 && m === "GET") return this.jobDetail(j);
      if (seg.length === 4 && seg[3] === "approve") return m === "POST" ? this.approve(j) : err(405, "method_not_allowed");
      if (seg.length === 4 && seg[3] === "decline") return m === "POST" ? this.decline(j) : err(405, "method_not_allowed");
      return err(404, "not_found");
    }

    if (route === "tokens") {
      if (seg.length === 2) {
        if (m === "GET") return json(this.sql.all<Row>("SELECT * FROM admin_tokens ORDER BY created_at DESC, id DESC").map((t) => this.tokenOut(t)));
        if (m === "POST") return this.createToken(req);
        return err(405, "method_not_allowed");
      }
      const t = this.one("SELECT * FROM admin_tokens WHERE id = ?", seg[2]);
      if (!t) return err(404, "not_found");
      if (seg.length === 4 && seg[3] === "revoke") return m === "POST" ? this.revokeToken(t) : err(405, "method_not_allowed");
      return err(404, "not_found");
    }

    if (route === "events") {
      if (m !== "GET") return err(405, "method_not_allowed");
      const after = Math.max(parseInt(url.searchParams.get("after") ?? "0", 10) || 0, 0);
      if (seg[2] === "stream" && seg.length === 3) return this.stream(req, after);
      if (seg.length === 2) {
        const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") ?? "200", 10) || 200, 1), 1000);
        return json(this.eventList(after, limit, url.searchParams.get("tail") === "1"));
      }
      return err(404, "not_found");
    }

    if (route === "laptop") {
      if (seg.length === 2 && m === "GET") return json(this.laptop());
      if (seg.length === 3 && seg[2] === "test") return m === "POST" ? json(await this.testLaptop()) : err(405, "method_not_allowed");
      if (seg.length === 3 && seg[2] === "rotate") return m === "POST" ? this.rotate() : err(405, "method_not_allowed");
      return err(404, "not_found");
    }
    return err(404, "not_found");
  }

  private keyOut(k: Row) {
    const c = this.contractRow(k.contract_id);
    return { id: k.id, label: k.label, prefix: k.prefix, contract: { id: k.contract_id, name: c?.name ?? "" }, project_id: k.project_id ?? null, created_at: k.created_at, last_used_at: k.last_used_at, revoked_at: k.revoked_at };
  }

  private daemonInfo() {
    const d = this.one("SELECT * FROM daemon WHERE id = 1");
    return { connected: !!this.daemon?.hello, last_seen: d?.last_seen ?? null, last_seq: this.lastSeq, rotated_at: d?.rotated_at ?? null, hint: d?.hint ?? null };
  }

  private jobList(state: string | null | undefined, limit: number, label?: string | null) {
    const where = [state ? "state = ?" : "", label ? "label = ?" : ""].filter(Boolean).join(" AND ");
    const rows = this.sql.all<Row>(`SELECT * FROM jobs${where ? ` WHERE ${where}` : ""} ORDER BY created_at DESC, id DESC LIMIT ?`, ...[state, label].filter(Boolean), limit);
    return rows.map(this.jobOut);
  }
  // `tail` returns the LAST `limit` events after `after` (still oldest first): what a page wants on first load. Without it
  // you get the first `limit` events after `after`, which is what replay and catch-up want.
  private eventList(after: number, limit: number, tail = false) {
    const rows = tail
      ? this.sql.all<Row>("SELECT * FROM (SELECT * FROM events WHERE seq > ? ORDER BY seq DESC LIMIT ?) ORDER BY seq", after, limit)
      : this.sql.all<Row>("SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?", after, limit);
    return { events: rows.map(this.evOut), last_seq: this.lastEventSeq() };
  }
  private keyDetail(k: Row) {
    const c = this.contractRow(k.contract_id)!;
    return { ...this.keyOut(k), recent_jobs: this.sql.all<Row>("SELECT * FROM jobs WHERE key_id = ? ORDER BY created_at DESC, id DESC LIMIT 10", k.id).map(this.jobOut), contract: this.contractOut(c) };
  }

  private state() { return json(this.stateObj()); }
  private stateObj() {
    const counts: Record<string, number> = {};
    // Active states are counted as they are now; finished ones only since 00:00 UTC, so "Today" on the overview is true.
    const dayStart = Date.now() - (Date.now() % 86_400_000);
    const active = new Set(["queued", "waiting_approval", "running"]);
    for (const s of STATES) counts[s] = active.has(s) ? this.one("SELECT COUNT(*) AS n FROM jobs WHERE state = ?", s)!.n : this.one("SELECT COUNT(*) AS n FROM jobs WHERE state = ? AND updated_at >= ?", s, dayStart)!.n;
    // Each waiting parcel carries its key's label, so the UI and the extension need no second request.
    const needs = this.sql.all<Row>("SELECT * FROM jobs WHERE state = 'waiting_approval' ORDER BY created_at, id").map(j => ({ ...this.jobOut(j), key: { id: j.key_id, label: this.one("SELECT label FROM keys WHERE id = ?", j.key_id)?.label ?? null } }));
    const latest = this.sql.all<Row>("SELECT * FROM events ORDER BY seq DESC LIMIT 5").map(this.evOut);
    const d = this.daemonInfo();
    return { daemon: { connected: d.connected, last_seen: d.last_seen, last_seq: d.last_seq }, counts, needs_you: needs, latest_events: latest, approvals: needs.length };
  }

  private async createKey(req: Request): Promise<Response> {
    const r = await this.readJson(req);
    if (!r.ok) return r.res;
    const o = await this.createKeyCore(r.body);
    return "errors" in o ? invalid(o.errors) : json(o, 201);
  }

  /** The one place a client key is made (owner route and MCP). The clear key leaves here once. */
  private async createKeyCore(body: Row): Promise<{ errors: Record<string, string> } | { id: string; label: string; key: string }> {
    const label = typeof body.label === "string" ? body.label.trim() : "";
    const errors: Record<string, string> = {};
    if (label.length < 1 || label.length > 60) errors.label = "Label must be 1 to 60 characters.";
    if (typeof body.contract_id !== "string" || !this.contractRow(body.contract_id)) errors.contract_id = "Unknown contract.";
    const target = this.projects.checkTarget(body.project_id);
    if (!target.ok) errors.project_id = target.error;
    if (Object.keys(errors).length) return { errors };
    const key = generateKey();
    const id = makeId("k_", this.next("key"));
    const now = Date.now();
    this.sql.run("INSERT INTO keys (id, label, prefix, hash, contract_id, created_at, project_id) VALUES (?, ?, ?, ?, ?, ?, ?)", id, label, displayPrefix(key), await hashToken(key), body.contract_id, now, target.ok ? target.id : null);
    this.event("key.created", { key_id: id, label });
    return { id, label, key };
  }

  private revoke(k: Row): Response { return json(this.revokeCore(k)); }

  private revokeCore(k: Row): { id: string; revoked_at: number; cancelled: number } {
    if (k.revoked_at) return { id: k.id, revoked_at: k.revoked_at, cancelled: 0 };
    const now = Date.now();
    this.sql.run("UPDATE keys SET revoked_at = ? WHERE id = ?", now, k.id);
    this.event("key.revoked", { key_id: k.id, label: k.label });
    let cancelled = 0;
    for (const j of this.sql.all<Row>("SELECT * FROM jobs WHERE key_id = ? AND state IN ('queued','waiting_approval','running') ORDER BY created_at, id", k.id)) {
      const wasRunning = j.state === "running";
      this.setState(j, "cancelled", "key revoked");
      cancelled++;
      if (wasRunning) {
        this.clearInflight(j.id);
        this.send({ type: "cancel", id: j.id });
      }
    }
    this.pushNext();
    return { id: k.id, revoked_at: now, cancelled };
  }

  private async saveContract(req: Request, existing: Row | null): Promise<Response> {
    const r = await this.readJson(req);
    if (!r.ok) return r.res;
    const o = this.saveContractCore(r.body, existing);
    return "errors" in o ? invalid(o.errors) : json(o.out, existing ? 200 : 201);
  }

  private saveContractCore(body: unknown, existing: Row | null): { errors: Record<string, string> } | { out: ReturnType<Hub["contractOut"]> } {
    const v = validateContract(body, { allowLocal: this.env.MAILROOM_ALLOW_LOCAL_URLS === "1" });
    if (!v.ok) return { errors: v.errors };
    const now = Date.now();
    const id = existing?.id ?? makeId("c_", this.next("contract"));
    const version = existing ? existing.version + 1 : 1;
    this.sql.run("INSERT INTO contracts (id, name, body, version, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET name = excluded.name, body = excluded.body, version = excluded.version, updated_at = excluded.updated_at", id, v.contract.name, JSON.stringify(v.contract), version, now);
    this.event("contract.saved", { contract_id: id, name: v.contract.name, version });
    if (existing) this.pushNext(); // queued jobs are re-checked against the new text
    return { out: this.contractOut(this.contractRow(id)!) };
  }

  private jobDetail(j: Row): Response { return json(this.jobDetailObj(j)); }
  private jobDetailObj(j: Row) {
    const c = this.contractRow(j.contract_id)!;
    const now = Date.now();
    const v = check(parse(c.body), { task: j.task, args: parse(j.args) }, { now, usedToday: this.usedToday(j.key_id, now, j.id) });
    const k = this.one("SELECT id, label FROM keys WHERE id = ?", j.key_id);
    const timeline = this.sql.all<Row>("SELECT * FROM events WHERE json_extract(payload, '$.job_id') = ? ORDER BY seq", j.id).map(this.evOut);
    this.sweepResults();
    return { ...this.jobOut(j), result: this.resultOf(j), timeline, contract_check: v.verdict === "refuse" ? { verdict: v.verdict, reason: v.reason } : { verdict: v.verdict }, key: k ?? { id: j.key_id, label: "" } };
  }

  /** Re-check a job against its contract's current text. Returns a refusal reason or null. */
  private recheck(j: Row): string | null {
    const c = this.contractRow(j.contract_id)!;
    const now = Date.now();
    j.contract_version = c.version;
    const v = check(parse(c.body), { task: j.task, args: parse(j.args) }, { now, usedToday: this.usedToday(j.key_id, now, j.id) });
    return v.verdict === "refuse" ? v.reason : null;
  }

  private approve(j: Row): Response {
    const o = this.approveCore(j);
    return "conflict" in o ? err(409, "conflict", { message: o.conflict }) : json(o.job);
  }
  private approveCore(j: Row) {
    if (j.state !== "waiting_approval") return { conflict: `job is ${j.state}` };
    const reason = this.recheck(j);
    if (reason) this.setState(j, "refused", reason);
    else {
      this.setState(j, "queued", null, undefined, "job.approved");
      this.pushNext();
    }
    return { job: this.jobOut(this.one("SELECT * FROM jobs WHERE id = ?", j.id)!) };
  }

  private decline(j: Row): Response {
    const o = this.declineCore(j);
    return "conflict" in o ? err(409, "conflict", { message: o.conflict }) : json(o.job);
  }
  private declineCore(j: Row, note?: string) {
    if (j.state !== "waiting_approval") return { conflict: `job is ${j.state}` };
    this.setState(j, "refused", note ? `declined by owner: ${note}` : "declined by owner", undefined, "job.declined");
    return { job: this.jobOut(this.one("SELECT * FROM jobs WHERE id = ?", j.id)!) };
  }

  // ---- admin tokens (owner routes) ----
  private tokenOut = (t: Row) => ({ id: t.id, label: t.label, prefix: t.prefix, scopes: parse(t.scopes) as string[], created_at: t.created_at, last_used_at: t.last_used_at, revoked_at: t.revoked_at });

  private async createToken(req: Request): Promise<Response> {
    const r = await this.readJson(req);
    if (!r.ok) return r.res;
    const v = validateTokenInput(r.body);
    if (!v.ok) return invalid(v.errors);
    const token = generateAdminToken();
    const id = makeId("t_", this.next("token"));
    this.sql.run("INSERT INTO admin_tokens (id, label, prefix, hash, scopes, created_at) VALUES (?, ?, ?, ?, ?, ?)", id, v.label, displayPrefix(token), await hashToken(token), JSON.stringify(v.scopes), Date.now());
    this.event("token.created", { token_id: id, label: v.label, scopes: v.scopes });
    return json({ id, label: v.label, scopes: v.scopes, token }, 201);
  }

  private revokeToken(t: Row): Response {
    if (t.revoked_at) return json({ id: t.id, revoked_at: t.revoked_at });
    const now = Date.now();
    this.sql.run("UPDATE admin_tokens SET revoked_at = ? WHERE id = ?", now, t.id);
    this.event("token.revoked", { token_id: t.id, label: t.label, scopes: parse(t.scopes) });
    return json({ id: t.id, revoked_at: now });
  }

  // ---- MCP admin channel ----
  private async mcpAuth(req: Request): Promise<Row | null> {
    const tok = bearer(req.headers.get("Authorization"));
    // Always hash, so a missing or wrong-kind token costs the same as a wrong one.
    const hash = await hashToken(tok ?? "");
    if (!tok || tokenKind(tok) !== "admin") return null;
    const t = this.sql.all<Row>("SELECT * FROM admin_tokens WHERE prefix = ? AND revoked_at IS NULL", displayPrefix(tok)).find((r) => safeEqual(r.hash, hash));
    if (!t) return null;
    const now = Date.now();
    if (t.last_used_at == null || now - t.last_used_at >= TOKEN_TOUCH_MS) {
      this.sql.run("UPDATE admin_tokens SET last_used_at = ? WHERE id = ?", now, t.id);
      t.last_used_at = now;
    }
    return t;
  }

  private async mcp(req: Request): Promise<Response> {
    if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405, { Allow: "POST" });
    const origin = req.headers.get("Origin");
    if (origin !== null && origin !== new URL(req.url).origin) return err(403, "bad_origin");
    const t = await this.mcpAuth(req);
    if (!t) return json({ error: "unauthorized" }, 401, { "WWW-Authenticate": "Bearer" });
    if (this.rateLimited(t.id, this.mcpRate, MCP_RATE_PER_MIN)) return json({ error: "rate_limited", retry_after: 60 }, 429, { "Retry-After": "60" });
    if (Number(req.headers.get("content-length") ?? 0) > MCP_MAX_BODY) return err(413, "too_large");
    const text = await req.text();
    if (this.enc.encode(text).length > MCP_MAX_BODY) return err(413, "too_large");

    const scopes = parse(t.scopes) as string[];
    const res = await handleMcpText(text, {
      scopes,
      api: this.mcpApi(),
      audit: (e) => void this.event("mcp.call", { token_id: t.id, label: t.label, tool: e.tool, ok: e.ok, ...(e.target ? { target: e.target } : {}) }),
    });
    return res === null ? new Response(null, { status: 202, headers: { "cache-control": "no-store" } }) : json(res);
  }

  /** The MCP tools call the same cores the owner routes use; nothing here re-implements a rule. */
  private mcpApi(): McpApi {
    const need = <T>(v: T | undefined, what: string): T => { if (v === undefined) throw new ToolError(`${what} not found.`); return v; };
    const fields = (errors: Record<string, string>) => new ToolError(`Nothing was saved. ${formatFieldErrors(errors)}`, errors);
    return {
      status: async () => this.stateObj(),
      listParcels: async ({ state, limit, label }) => this.jobList(state, limit, label),
      getParcel: async (id) => this.jobDetailObj(need(this.one("SELECT * FROM jobs WHERE id = ?", id), `Parcel ${id}`)),
      listKeys: async () => this.sql.all<Row>("SELECT * FROM keys ORDER BY created_at DESC, id DESC").map((k) => this.keyOut(k)),
      getKey: async (id) => this.keyDetail(need(this.one("SELECT * FROM keys WHERE id = ?", id), `Key ${id}`)),
      listContracts: async () => this.sql.all<Row>("SELECT * FROM contracts ORDER BY updated_at DESC, id DESC").map((c) => this.contractOut(c)),
      getContract: async (id) => this.contractOut(need(this.contractRow(id), `Contract ${id}`)),
      events: async ({ after, limit }) => this.eventList(after, limit),
      laptop: async () => this.laptop(),
      createContract: async (body) => {
        const o = this.saveContractCore(body, null);
        if ("errors" in o) throw fields(o.errors);
        return o.out;
      },
      updateContract: async (id, body) => {
        const o = this.saveContractCore(body, need(this.contractRow(id), `Contract ${id}`));
        if ("errors" in o) throw fields(o.errors);
        return o.out;
      },
      createKey: async (a) => {
        const o = await this.createKeyCore(a);
        if ("errors" in o) throw fields(o.errors);
        return o;
      },
      revokeKey: async (id) => this.revokeCore(need(this.one("SELECT * FROM keys WHERE id = ?", id), `Key ${id}`)),
      approveParcel: async (id) => {
        const o = this.approveCore(need(this.one("SELECT * FROM jobs WHERE id = ?", id), `Parcel ${id}`));
        if ("conflict" in o) throw new ToolError(`Parcel ${id} cannot be approved: ${o.conflict}. Only parcels waiting for approval can be.`);
        return { id: o.job.id, state: o.job.state, ...(o.job.reason ? { reason: o.job.reason } : {}) };
      },
      declineParcel: async (id, reason) => {
        const o = this.declineCore(need(this.one("SELECT * FROM jobs WHERE id = ?", id), `Parcel ${id}`), reason);
        if ("conflict" in o) throw new ToolError(`Parcel ${id} cannot be declined: ${o.conflict}. Only parcels waiting for approval can be.`);
        return { id: o.job.id, state: o.job.state };
      },
    };
  }

  // ---- events: SSE ----
  private stream(req: Request, afterQ: number): Response {
    const lastId = parseInt(req.headers.get("Last-Event-ID") ?? "", 10);
    const after = Number.isFinite(lastId) && lastId > afterQ ? lastId : afterQ;
    let ctl!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start: (c) => {
        ctl = c;
        c.enqueue(this.enc.encode(": open\n\n"));
        for (const r of this.sql.all<Row>("SELECT * FROM events WHERE seq > ? ORDER BY seq", after)) {
          const ev = this.evOut(r);
          c.enqueue(this.enc.encode(`id: ${ev.seq}\ndata: ${JSON.stringify(ev)}\n\n`));
        }
        this.subs.add(c); // same synchronous turn as the replay: nothing is missed or doubled
        if (!this.sseTimer) this.sseTimer = setInterval(() => this.ssePing(), SSE_PING_MS);
      },
      cancel: () => {
        this.subs.delete(ctl);
        if (!this.subs.size && this.sseTimer) { clearInterval(this.sseTimer); this.sseTimer = null; }
      },
    });
    req.signal?.addEventListener("abort", () => this.subs.delete(ctl));
    return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-store", "x-accel-buffering": "no" } });
  }

  private ssePing() {
    const frame = this.enc.encode(": ping\n\n");
    for (const c of this.subs) {
      try { c.enqueue(frame); } catch { this.subs.delete(c); }
    }
    if (!this.subs.size && this.sseTimer) { clearInterval(this.sseTimer); this.sseTimer = null; }
  }

  // ---- laptop ----
  /** A live round trip: the Hub sends a tagged ping and the laptop must echo the tag. Tells "connected" from "looks connected". */
  private async testLaptop(): Promise<{ ok: boolean; ms?: number; reason?: string }> {
    const dm = this.daemon;
    if (!dm?.hello) return { ok: false, reason: "No laptop is connected to the Hub right now." };
    const id = crypto.randomUUID();
    const t0 = Date.now();
    const answered = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 5000);
      dm.pings.set(id, () => { clearTimeout(timer); resolve(true); });
    });
    try { dm.ws.send(JSON.stringify({ type: "ping", id })); } catch { dm.pings.delete(id); return { ok: false, reason: "The connection is broken." }; }
    const ok = await answered;
    dm.pings.delete(id);
    return ok ? { ok: true, ms: Date.now() - t0 } : { ok: false, reason: "The laptop is connected but did not answer within 5 seconds. It may be asleep, or running an older daemon (restart it)." };
  }

  private laptop() {
    const d = this.daemonInfo();
    return { connected: d.connected, last_seen: d.last_seen, last_seq: d.last_seq, rotated_at: d.rotated_at, credential_hint: d.hint, queue: this.sql.all<Row>("SELECT * FROM jobs WHERE state = 'queued' ORDER BY created_at, id").map(this.jobOut) };
  }

  private async rotate(): Promise<Response> {
    const cred = generateDaemonCredential();
    const now = Date.now();
    this.sql.run("INSERT INTO daemon (id, hash, hint, rotated_at, last_seen, connected) VALUES (1, ?, ?, ?, NULL, 0) ON CONFLICT (id) DO UPDATE SET hash = excluded.hash, hint = excluded.hint, rotated_at = excluded.rotated_at", await hashToken(cred), credentialHint(cred), now);
    this.event("daemon.rotated", {});
    this.dropDaemon(this.daemon, 4001);
    return json({ credential: cred });
  }

  // ---- daemon WebSocket ----
  private async daemonUpgrade(req: Request): Promise<Response> {
    // `?probe=1` only checks the credential and reports whether a laptop is connected. It must never replace the live
    // connection: `mailroom status` used to open a second daemon socket, which kicked the running daemon off.
    const probe = new URL(req.url).searchParams.get("probe") === "1";
    if (!probe && req.headers.get("Upgrade")?.toLowerCase() !== "websocket") return err(426, "upgrade_required");
    const tok = bearer(req.headers.get("Authorization"));
    const d = this.one("SELECT hash FROM daemon WHERE id = 1");
    // Always hash and compare, so a missing or wrong-kind token costs the same as a wrong one.
    const hash = await hashToken(tok ?? "");
    if (!tok || tokenKind(tok) !== "daemon" || !d || !safeEqual(d.hash, hash)) return err(401, "bad_credential");
    if (probe) return json({ ok: true, connected: !!this.daemon?.hello });

    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    server.accept();
    this.dropDaemon(this.daemon, 4002); // a new valid connection replaces the old one
    const dm: Daemon = { ws: server, hello: false, lastPong: Date.now(), timer: null, pings: new Map() };
    this.daemon = dm;
    dm.timer = setInterval(() => {
      if (Date.now() - dm.lastPong > DEAD_MS) return this.dropDaemon(dm, 1011);
      try { server.send(JSON.stringify({ type: "ping" })); } catch { this.dropDaemon(dm, 1011); }
    }, PING_MS);
    server.addEventListener("message", (e) => { try { this.onDaemonMessage(dm, e.data); } catch (x) { console.error("daemon msg", x instanceof Error ? x.message : "?"); } });
    server.addEventListener("close", () => this.dropDaemon(dm));
    server.addEventListener("error", () => this.dropDaemon(dm));
    return new Response(null, { status: 101, webSocket: client });
  }

  private send(msg: unknown): boolean {
    if (!this.daemon?.hello) return false;
    try { this.daemon.ws.send(JSON.stringify(msg)); return true; } catch { return false; }
  }

  private touchDaemon(dm: Daemon) {
    dm.lastPong = Date.now();
    this.sql.run("UPDATE daemon SET last_seen = ? WHERE id = 1", dm.lastPong);
  }

  private onDaemonMessage(dm: Daemon, data: unknown) {
    if (this.daemon !== dm || typeof data !== "string" || data.length > 2 * MAX_RESULT_BYTES + MAX_BODY) return;
    let m: any;
    try { m = JSON.parse(data); } catch { return; }
    if (!m || typeof m.type !== "string") return;
    this.touchDaemon(dm);
    if (m.type === "pong") {
      if (typeof m.id === "string") dm.pings.get(m.id)?.(); // an answer to a test ping
      return;
    }
    if (m.type === "hello") {
      if (dm.hello) return;
      dm.hello = true;
      this.laneMode = parseHello(m.lanes);
      this.lastSeq = Number.isInteger(m.last_seq) ? m.last_seq : 0;
      // Which commands the laptop says are safe to run twice (see isRerunSafe). A daemon that sends none has none.
      this.sql.run("DELETE FROM daemon_rerun");
      for (const n of parseRerunSafe(m.rerunSafe)) this.sql.run("INSERT OR IGNORE INTO daemon_rerun (name) VALUES (?)", n);
      this.sql.run("UPDATE daemon SET connected = 1 WHERE id = 1");
      if (m.commands !== undefined) storeReport(this.sql, m.commands); // untrusted display data; an old daemon sends none and the last snapshot stays
      if (m.prompts !== undefined) storePromptReport(this.sql, m.prompts); // same: untrusted display data (names and variable specs)
      this.event("daemon.connected", {});
      this.send({ type: "welcome", server_seq: this.lastEventSeq() });
      this.pushNext();
      return;
    }
    if (!dm.hello || typeof m.id !== "string") return;
    const j = this.one("SELECT * FROM jobs WHERE id = ?", m.id);
    if (!j || j.state !== "running") return; // late or stray (e.g. cancelled): ignore
    if (m.type === "progress") {
      if (typeof m.text !== "string" || !this.isInflight(j.id)) return;
      const pct = typeof m.pct === "number" && Number.isFinite(m.pct) ? Math.min(100, Math.max(0, m.pct)) : null;
      this.sql.run("INSERT OR REPLACE INTO job_progress (job_id, text, pct, at) VALUES (?, ?, ?, ?)", j.id, m.text.slice(0, 500), pct, Date.now());
      return;
    }
    if (m.type === "result") {
      if (m.ok === true) {
        const plan = planResult(JSON.stringify(m.result ?? null) ?? "null");
        if (plan.kind === "too_large") this.setState(j, "failed", `result is bigger than ${MAX_RESULT_BYTES / 1024 / 1024} MB`);
        else this.setState(j, "done", null, m.result ?? null);
      }
      else this.setState(j, "failed", typeof m.error === "string" ? m.error.slice(0, 2000) : "failed");
    } else if (m.type === "refuse") this.setState(j, "refused", typeof m.reason === "string" ? m.reason.slice(0, 2000) : "refused by laptop");
    else return;
    this.clearInflight(j.id);
    this.pushNext();
  }

  /** Closes a daemon connection (if it is still the live one), requeues what it was running, records the disconnect. */
  private dropDaemon(dm: Daemon | null, code?: number) {
    if (!dm) return;
    if (dm.timer) { clearInterval(dm.timer); dm.timer = null; }
    if (code) { try { dm.ws.close(code, code === 4001 ? "rotated" : code === 4002 ? "replaced" : "closing"); } catch { /* already closed */ } }
    if (this.daemon !== dm) return;
    this.daemon = null;
    this.inflight.clear();
    this.laneMode = null;
    this.sql.run("UPDATE daemon SET connected = 0 WHERE id = 1");
    if (dm.hello) this.event("daemon.disconnected", {});
    for (const j of this.sql.all<Row>("SELECT * FROM jobs WHERE state = 'running' ORDER BY created_at, id")) this.requeueOrFail(j);
  }

  private isInflight(id: string) { return [...this.inflight.values()].includes(id); }
  private clearInflight(id: string) { for (const [k, v] of this.inflight) if (v === id) this.inflight.delete(k); }

  /** Pushes the oldest queued job of every free lane, re-checking its contract first. One job per lane (one in all for an old daemon). */
  private pushNext() {
    for (let guard = 0; guard < 1000; guard++) {
      if (!this.daemon?.hello) return;
      const queued = this.sql.all<Row>("SELECT * FROM jobs WHERE state = 'queued' ORDER BY created_at, id LIMIT 500").map(r => ({ row: r, task: r.task as string, args: parse(r.args) }));
      const j = pickNext(queued, new Set(this.inflight.keys()), this.laneMode)?.row;
      if (!j) return;
      const reason = this.recheck(j);
      if (reason) { this.setState(j, "refused", reason); continue; }
      const c = this.contractRow(j.contract_id)!;
      const lane = laneOf(j.task, parse(j.args), this.laneMode?.hints);
      const ok = this.send({ type: "job", id: j.id, task: j.task, args: parse(j.args), lane, contract: parse(c.body), contract_version: c.version });
      if (!ok) return;
      this.inflight.set(laneKey(!!this.laneMode, lane), j.id);
      this.setState(j, "running");
    }
  }
}
