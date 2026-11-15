#!/usr/bin/env node
// Zero-dependency mock of docs/api.md (/admin/* and /api/*) plus the static ui/ folder, so the admin UI can be
// exercised without the Worker.  Run: node scripts/ui-mock.mjs   ->  http://localhost:8799
// Owner password: "mailroom" (override with MOCK_PASSWORD). Data is in memory and resets on restart.
// Handy routes: GET /mock/offline?on=1|0 (toggle the daemon, no arg = toggle), GET /mock/event (emit a fake event),
// GET /mock/reset-lock (clear the login lockout). Start offline with ?offline in the first URL or MOCK_OFFLINE=1.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import crypto from "node:crypto";

const PORT = Number(process.env.PORT || 8799);
const PASSWORD = process.env.MOCK_PASSWORD || "mailroom";
const UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../ui");
const TASKS = ["echo", "read_file", "write_file", "claude"];
const now = Date.now();
const min = 60e3;
const t = (m) => now - m * min;

// ---------------------------------------------------------------- data
const db = {
  daemon: { connected: process.env.MOCK_OFFLINE !== "1", last_seen: t(0), rotated_at: t(6 * 1440), hint: "mrd_...9a3f", seq: 0 },
  contracts: new Map(), keys: new Map(), jobs: new Map(), events: [],
};
let seq = 400;
const sessions = new Set();
const clients = new Set();
const fails = new Map(); // ip -> {n, until}
let counter = 4824;

function emit(kind, payload, ts = Date.now()) {
  const e = { seq: ++seq, ts, kind, payload };
  db.events.push(e);
  db.daemon.seq = e.seq;
  for (const res of clients) res.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`);
  return e;
}
const putContract = (id, c, version = 1) => db.contracts.set(id, { id, ...c, version, updated_at: now });
putContract("c_notes", { name: "Notes writer", folders: ["~/Hobby/dunder/notes"], tasks: ["echo", "read_file", "write_file"], dailyLimit: 50, expires: null, approval: ["write_file"] });
putContract("c_docs", { name: "Docs reader", folders: ["~/Documents/public"], tasks: ["read_file"], dailyLimit: 200, expires: "2026-12-31T00:00:00.000Z", approval: [] });
putContract("c_scratch", { name: "Scratch", folders: ["~/scratch"], tasks: ["echo"], dailyLimit: 20, expires: null, approval: [] });
const putKey = (id, label, prefix, contract_id, created, used, secret) => db.keys.set(id, { id, label, prefix, contract_id, created_at: created, last_used_at: used, revoked_at: null, secret });
putKey("k_prod", "Dunder Miffbot (prod)", "mr_live_9aKd", "c_notes", t(12 * 1440), t(2));
putKey("k_stage", "Dunder Miffbot (staging)", "mr_live_2Lm8", "c_notes", t(12 * 1440), t(180));
putKey("k_hobby", "Hobby scripts", "mr_live_7Qx2", "c_scratch", t(5), null);
const putJob = (n, key, task, args, state, created, extra = {}) => db.jobs.set("p_" + n, { id: "p_" + n, key_id: key, contract_id: db.keys.get(key).contract_id, contract_version: 1, task, args, state, reason: null, result: null, created_at: created, updated_at: created, ...extra });
putJob(4816, "k_prod", "echo", { text: "hi" }, "done", t(50), { result: { echo: "hi" } });
putJob(4817, "k_prod", "echo", { text: "ping" }, "queued", t(47));
putJob(4818, "k_stage", "write_file", { path: "~/Hobby/dunder/notes/log.md", content: "# log\n" }, "running", t(46));
putJob(4819, "k_hobby", "echo", { text: "hello from the cloud" }, "done", t(44), { result: { echo: "hello from the cloud" } });
putJob(4820, "k_prod", "read_file", { path: "~/Documents/taxes/2025.pdf" }, "refused", t(42), { reason: "folder is outside the contract" });
putJob(4821, "k_prod", "write_file", { path: "~/Hobby/dunder/notes/standup.md", content: "# Standup 15 Nov\n- shipped the gateway rate limit\n- next: approval UI\n".padEnd(214, " ") }, "waiting_approval", t(41));
putJob(4822, "k_prod", "write_file", { path: "~/Hobby/dunder/notes/ideas.md", content: "x".repeat(98) }, "waiting_approval", t(40));
const seedEv = (kind, p, m) => emit(kind, p, t(m));
seq = 404;
seedEv("daemon.disconnected", {}, 60); seedEv("daemon.connected", {}, 55); seedEv("key.created", { key_id: "k_hobby", label: "Hobby scripts" }, 5);
for (const [id, kind, m] of [["p_4816", "job.queued", 50], ["p_4816", "job.done", 50], ["p_4819", "job.queued", 44], ["p_4819", "job.running", 44], ["p_4819", "job.done", 44],
  ["p_4820", "job.refused", 42], ["p_4821", "job.waiting_approval", 41], ["p_4822", "job.waiting_approval", 40]]) {
  const j = db.jobs.get(id);
  emit(kind, { job_id: id, key_id: j.key_id, task: j.task, ...(kind === "job.refused" ? { reason: j.reason } : {}) }, t(m));
}

// ---------------------------------------------------------------- rules (mirror of shared/contract.ts, abridged)
function normalize(p) {
  if (typeof p !== "string" || !p) return null;
  let root = "", rest = p;
  if (p === "~" || p.startsWith("~/")) { root = "~"; rest = p.slice(1); } else if (!p.startsWith("/")) return null;
  const out = [];
  for (const s of rest.split("/")) { if (!s || s === ".") continue; if (s === "..") { if (!out.length) return null; out.pop(); } else out.push(s); }
  return root + (out.length || root ? "/" + out.join("/") : "/").replace(/^\/$/, root ? "" : "/");
}
function validate(o) {
  const errors = {};
  o = o && typeof o === "object" ? o : {};
  const name = typeof o.name === "string" ? o.name.trim() : "";
  if (!/^[\w .()-]{1,60}$/.test(name)) errors.name = "Give it a short name (letters, numbers, spaces).";
  const folders = [];
  if (!Array.isArray(o.folders) || !o.folders.length) errors.folders = "Allow at least one folder.";
  else for (const f of o.folders) { const n = typeof f === "string" ? normalize(f.trim()) : null; if (n === null || n === "~" || n === "/") { errors.folders = `Folders must start with ~/ or /. “${String(f)}” could mean anywhere.`; break; } folders.push(n); }
  const tasks = [];
  if (!Array.isArray(o.tasks) || !o.tasks.length) errors.tasks = "Allow at least one task.";
  else for (const x of o.tasks) { if (!TASKS.includes(x)) { errors.tasks = `Unknown task “${String(x)}”.`; break; } if (!tasks.includes(x)) tasks.push(x); }
  if (!Number.isInteger(o.dailyLimit) || o.dailyLimit < 1 || o.dailyLimit > 100000) errors.dailyLimit = "Use a whole number, like 50.";
  let expires = null;
  if (o.expires) { const ms = Date.parse(o.expires); if (Number.isNaN(ms)) errors.expires = "Use a date like 2026-12-31, or leave it empty for never."; else expires = new Date(ms).toISOString(); }
  const approval = [];
  for (const a of Array.isArray(o.approval) ? o.approval : []) { if (!tasks.includes(a)) { errors.approval = "Approval can only be set on tasks the contract allows."; break; } approval.push(a); }
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, contract: { name, folders, tasks, dailyLimit: o.dailyLimit, expires, approval } };
}
function check(c, job, used) {
  if (!c.tasks.includes(job.task)) return { verdict: "refuse", reason: `task ${job.task} is not allowed` };
  if (used >= c.dailyLimit) return { verdict: "refuse", reason: "daily limit reached" };
  const p = job.args && (job.args.path || job.args.cwd);
  if (p !== undefined) { const n = normalize(String(p)); if (n === null || !c.folders.some((f) => n === f || n.startsWith(f + "/"))) return { verdict: "refuse", reason: "folder is outside the contract" }; }
  return c.approval.includes(job.task) ? { verdict: "approve" } : { verdict: "allow" };
}

// ---------------------------------------------------------------- helpers
const json = (res, status, body, headers = {}) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers }); res.end(body === undefined ? "" : JSON.stringify(body)); };
const err = (res, status, error, extra = {}) => json(res, status, { error, ...extra });
const keyOut = (k) => ({ id: k.id, label: k.label, prefix: k.prefix, contract: { id: k.contract_id, name: db.contracts.get(k.contract_id)?.name }, created_at: k.created_at, last_used_at: k.last_used_at, revoked_at: k.revoked_at });
const jobOut = ({ ...j }) => j;
const newest = () => [...db.jobs.values()].sort((a, b) => b.created_at - a.created_at || b.id.localeCompare(a.id));
const jobEvents = (id) => db.events.filter((e) => e.payload.job_id === id);
const usedBy = (cid) => [...db.keys.values()].filter((k) => k.contract_id === cid && !k.revoked_at).length;
function setState(job, state, reason) { job.state = state; job.updated_at = Date.now(); if (reason) job.reason = reason; }
function pushQueued() { // pretend the daemon runs queued jobs when it is connected
  if (!db.daemon.connected) return;
  for (const j of newest().reverse()) if (j.state === "queued") {
    setState(j, "running"); emit("job.running", { job_id: j.id, key_id: j.key_id, task: j.task });
    setTimeout(() => { if (j.state !== "running") return; j.result = j.task === "echo" ? { echo: j.args.text } : { ok: true }; setState(j, "done"); emit("job.done", { job_id: j.id, key_id: j.key_id, task: j.task }); }, 800);
  }
}
const body = (req) => new Promise((ok) => { let s = ""; req.on("data", (c) => { s += c; if (s.length > 262144) req.destroy(); }); req.on("end", () => { try { ok(s ? JSON.parse(s) : {}); } catch { ok(null); } }); });
const cookie = (req) => Object.fromEntries((req.headers.cookie || "").split(/;\s*/).filter(Boolean).map((c) => c.split("=")));
const authed = (req) => sessions.has(cookie(req).mr_session);
const base62 = (n) => [...crypto.randomBytes(n)].map((b) => "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"[b % 62]).join("");

// ---------------------------------------------------------------- owner routes
async function admin(req, res, url) {
  const m = req.method, p = url.pathname, seg = p.split("/").filter(Boolean); // ["admin", ...]
  if (m !== "GET" && req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return err(res, 403, "bad_origin");
  if (p === "/admin/login" && m === "POST") {
    const ip = req.socket.remoteAddress, f = fails.get(ip) || { n: 0, until: 0 };
    if (f.until > Date.now()) return err(res, 429, "locked", { retry_after: Math.ceil((f.until - Date.now()) / 1000) });
    const b = (await body(req)) || {};
    if (b.password === PASSWORD) { fails.delete(ip); const id = crypto.randomUUID(); sessions.add(id); res.writeHead(204, { "set-cookie": `mr_session=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800` }); return res.end(); }
    f.n++;
    if (f.n >= 5) { f.until = Date.now() + 15 * 60e3; f.n = 0; fails.set(ip, f); return err(res, 429, "locked", { retry_after: 900 }); }
    fails.set(ip, f);
    return err(res, 401, "bad_password", { tries_left: 5 - f.n });
  }
  if (p === "/admin/logout" && m === "POST") { sessions.delete(cookie(req).mr_session); res.writeHead(204, { "set-cookie": "mr_session=; Max-Age=0; Path=/" }); return res.end(); }
  if (!authed(req)) return err(res, 401, "signed_out");

  if (p === "/admin/state" && m === "GET") {
    const counts = { queued: 0, waiting_approval: 0, running: 0, done: 0, refused: 0, failed: 0 };
    for (const j of db.jobs.values()) if (j.state in counts) counts[j.state]++;
    const needs = newest().filter((j) => j.state === "waiting_approval").reverse();
    return json(res, 200, { daemon: { connected: db.daemon.connected, last_seen: db.daemon.last_seen, last_seq: db.daemon.seq }, counts, needs_you: needs, latest_events: db.events.slice(-5).reverse(), approvals: needs.length });
  }
  if (p === "/admin/keys" && m === "GET") return json(res, 200, [...db.keys.values()].map(keyOut));
  if (p === "/admin/keys" && m === "POST") {
    const b = (await body(req)) || {}, errors = {};
    const label = typeof b.label === "string" ? b.label.trim() : "";
    if (label.length < 1 || label.length > 60) errors.label = "Every key needs a label, or you will not remember who it is.";
    if (!db.contracts.has(b.contract_id)) errors.contract_id = "Unknown contract.";
    if (Object.keys(errors).length) return err(res, 422, "invalid", { errors });
    const secret = "mr_live_" + base62(32), id = "k_" + base62(6).toLowerCase();
    putKey(id, label, secret.slice(0, 12), b.contract_id, Date.now(), null, secret);
    emit("key.created", { key_id: id, label });
    return json(res, 201, { id, label, key: secret });
  }
  if (seg[1] === "keys" && seg[2]) {
    const k = db.keys.get(seg[2]);
    if (!k) return err(res, 404, "not_found");
    if (m === "GET" && !seg[3]) return json(res, 200, { ...keyOut(k), contract: { ...db.contracts.get(k.contract_id) }, contract_id: k.contract_id, recent_jobs: newest().filter((j) => j.key_id === k.id).slice(0, 10) });
    if (m === "POST" && seg[3] === "revoke") {
      if (k.revoked_at) return err(res, 409, "conflict");
      k.revoked_at = Date.now();
      let cancelled = 0;
      for (const j of db.jobs.values()) if (j.key_id === k.id && (j.state === "queued" || j.state === "waiting_approval")) { setState(j, "cancelled"); emit("job.cancelled", { job_id: j.id, key_id: k.id, task: j.task }); cancelled++; }
      emit("key.revoked", { key_id: k.id, label: k.label });
      return json(res, 200, { id: k.id, revoked_at: k.revoked_at, cancelled });
    }
  }
  if (p === "/admin/contracts" && m === "GET") return json(res, 200, [...db.contracts.values()].map((c) => ({ ...c, used_by: usedBy(c.id) })));
  if (p === "/admin/contracts" && m === "POST") {
    const r = validate(await body(req));
    if (!r.ok) return err(res, 422, "invalid", { errors: r.errors });
    const id = "c_" + base62(6).toLowerCase(); putContract(id, r.contract);
    emit("contract.saved", { contract_id: id, name: r.contract.name, version: 1 });
    return json(res, 201, { ...db.contracts.get(id), used_by: 0 });
  }
  if (seg[1] === "contracts" && seg[2]) {
    const c = db.contracts.get(seg[2]);
    if (!c) return err(res, 404, "not_found");
    if (m === "GET") return json(res, 200, { ...c, used_by: usedBy(c.id) });
    if (m === "PUT") {
      const r = validate(await body(req));
      if (!r.ok) return err(res, 422, "invalid", { errors: r.errors });
      putContract(c.id, r.contract, c.version + 1);
      emit("contract.saved", { contract_id: c.id, name: r.contract.name, version: c.version + 1 });
      return json(res, 200, { ...db.contracts.get(c.id), used_by: usedBy(c.id) });
    }
  }
  if (p === "/admin/jobs" && m === "GET") {
    const st = url.searchParams.get("state"), limit = Number(url.searchParams.get("limit") || 50);
    return json(res, 200, newest().filter((j) => !st || j.state === st).slice(0, limit).map(jobOut));
  }
  if (seg[1] === "jobs" && seg[2]) {
    const j = db.jobs.get(seg[2]);
    if (!j) return err(res, 404, "not_found");
    if (m === "GET" && !seg[3]) {
      const k = db.keys.get(j.key_id);
      return json(res, 200, { ...j, timeline: jobEvents(j.id), contract_check: check(db.contracts.get(j.contract_id), j, 0), key: { id: k.id, label: k.label }, contract: { id: j.contract_id, name: db.contracts.get(j.contract_id)?.name } });
    }
    if (m === "POST" && (seg[3] === "approve" || seg[3] === "decline")) {
      if (j.state !== "waiting_approval") return err(res, 409, "conflict");
      if (seg[3] === "approve") { setState(j, "queued"); emit("job.approved", { job_id: j.id, key_id: j.key_id, task: j.task }); pushQueued(); }
      else { setState(j, "refused", "declined by owner"); emit("job.declined", { job_id: j.id, key_id: j.key_id, task: j.task, reason: "declined by owner" }); }
      return json(res, 200, jobOut(j));
    }
  }
  if (p === "/admin/events" && m === "GET") {
    const after = Number(url.searchParams.get("after") || 0), limit = Number(url.searchParams.get("limit") || 100);
    const list = after ? db.events.filter((e) => e.seq > after).slice(0, limit) : db.events.slice(-limit);
    return json(res, 200, { events: list, last_seq: seq });
  }
  if (p === "/admin/events/stream" && m === "GET") {
    const after = Number(url.searchParams.get("after") || req.headers["last-event-id"] || 0);
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
    res.write(": hello\n\n");
    for (const e of db.events) if (e.seq > after) res.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`);
    clients.add(res);
    const ping = setInterval(() => res.write(": ping\n\n"), 20000);
    req.on("close", () => { clients.delete(res); clearInterval(ping); });
    return;
  }
  if (p === "/admin/laptop" && m === "GET") return json(res, 200, { connected: db.daemon.connected, last_seen: db.daemon.last_seen, last_seq: db.daemon.seq, rotated_at: db.daemon.rotated_at, credential_hint: db.daemon.hint, queue: newest().filter((j) => j.state === "queued").reverse() });
  if (p === "/admin/laptop/rotate" && m === "POST") {
    const cred = "mrd_" + base62(32);
    db.daemon.hint = "mrd_..." + cred.slice(-4); db.daemon.rotated_at = Date.now(); db.daemon.connected = false; db.daemon.last_seen = Date.now();
    emit("daemon.rotated", {}); emit("daemon.disconnected", {});
    return json(res, 200, { credential: cred });
  }
  return err(res, 404, "not_found");
}

// ---------------------------------------------------------------- client routes
async function client(req, res, url) {
  const tok = (req.headers.authorization || "").replace(/^Bearer /, "");
  const key = [...db.keys.values()].find((k) => k.secret === tok);
  if (!key || key.revoked_at) return err(res, 401, "bad_key");
  const parts = url.pathname.split("/").filter(Boolean);
  if (req.method === "GET" && parts[1] === "jobs" && parts[2]) {
    const j = db.jobs.get(parts[2]);
    return j && j.key_id === key.id ? json(res, 200, { id: j.id, state: j.state, reason: j.reason ?? undefined, result: j.result ?? undefined, created_at: j.created_at, updated_at: j.updated_at }) : err(res, 404, "not_found");
  }
  if (req.method === "POST" && url.pathname === "/api/jobs") {
    const b = (await body(req)) || {};
    const c = db.contracts.get(key.contract_id);
    const id = "p_" + ++counter, used = [...db.jobs.values()].filter((j) => j.key_id === key.id && j.state !== "refused").length;
    const v = check(c, b, used);
    key.last_used_at = Date.now();
    const state = v.verdict === "refuse" ? "refused" : v.verdict === "approve" ? "waiting_approval" : "queued";
    db.jobs.set(id, { id, key_id: key.id, contract_id: c.id, contract_version: c.version, task: b.task, args: b.args || {}, state, reason: v.reason || null, result: null, created_at: Date.now(), updated_at: Date.now() });
    emit(state === "refused" ? "job.refused" : state === "queued" ? "job.queued" : "job.waiting_approval", { job_id: id, key_id: key.id, task: b.task, ...(v.reason ? { reason: v.reason } : {}) });
    if (state === "queued") pushQueued();
    return json(res, state === "refused" ? 403 : 202, { id, state, ...(v.reason ? { reason: v.reason } : {}) });
  }
  return err(res, 404, "not_found");
}

// ---------------------------------------------------------------- static + dispatch
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".json": "application/json", ".png": "image/png", ".ico": "image/x-icon" };
const PUBLIC = ["/login.html", "/favicon.svg", "/css/", "/js/theme-init.js", "/js/theme.js", "/js/dom.js", "/js/login.js"];

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === "/mock/offline") { db.daemon.connected = url.searchParams.has("on") ? url.searchParams.get("on") !== "0" : !db.daemon.connected; if (!db.daemon.connected) { db.daemon.last_seen = Date.now(); emit("daemon.disconnected", {}); } else { emit("daemon.connected", {}); pushQueued(); } return json(res, 200, { connected: db.daemon.connected }); }
    if (url.pathname === "/mock/event") { const j = [...db.jobs.values()][0]; return json(res, 200, emit("job.done", { job_id: j.id, key_id: j.key_id, task: j.task })); }
    if (url.pathname === "/mock/reset-lock") { fails.clear(); return json(res, 200, { ok: true }); }
    if (url.pathname.startsWith("/admin/")) return await admin(req, res, url);
    if (url.pathname.startsWith("/api/")) return await client(req, res, url);
    let rel = url.pathname === "/" ? "/index.html" : url.pathname;
    if (!authed(req) && !PUBLIC.some((p) => rel === p || (p.endsWith("/") && rel.startsWith(p)))) { res.writeHead(302, { location: "/login.html" }); return res.end(); }
    const file = path.join(UI, path.normalize(rel));
    if (!file.startsWith(UI + path.sep)) return err(res, 403, "forbidden");
    const data = await readFile(file);
    res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" });
    res.end(data);
  } catch (e) {
    if (e.code === "ENOENT" || e.code === "EISDIR") return err(res, 404, "not_found");
    console.error(e); err(res, 500, "internal");
  }
}).listen(PORT, () => console.log(`mailroom ui mock on http://localhost:${PORT}  (password: ${PASSWORD === "mailroom" ? "mailroom" : "from MOCK_PASSWORD"})`));
