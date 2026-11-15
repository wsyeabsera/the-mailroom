// End-to-end smoke test against a running `wrangler dev`. Usage: node scripts/smoke.mjs [baseUrl]
import { readFileSync } from "node:fs";
import WebSocket from "ws";

const BASE = (process.argv[2] ?? "http://localhost:8787").replace(/\/$/, "");
const vars = Object.fromEntries(readFileSync(new URL("../.dev.vars", import.meta.url), "utf8").split("\n").filter((l) => l.includes("=") && !l.startsWith("#")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
let cookie = "";
let n = 0;
const ok = (cond, msg) => { if (!cond) throw new Error(`FAIL: ${msg}`); console.log(`ok ${++n} ${msg}`); };

async function call(method, path, { body, key, auth = true, headers = {} } = {}) {
  const h = { ...headers };
  if (body !== undefined) h["content-type"] = "application/json";
  if (key) h.Authorization = `Bearer ${key}`;
  if (auth && cookie) h.Cookie = cookie;
  const res = await fetch(BASE + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : undefined; } catch { data = text; }
  return { status: res.status, data, res };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 5000) { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error(`FAIL: timeout waiting for ${what}`); await sleep(100); } }

// gate
let r = await call("GET", "/", { auth: false });
ok(r.status === 302 || r.status === 200, "unauthenticated / is redirected or login page");
r = await call("GET", "/admin/state", { auth: false });
ok(r.status === 401 && r.data.error === "signed_out", "admin without session is 401 signed_out");

// login
r = await call("POST", "/admin/login", { body: { password: "definitely-wrong" }, auth: false });
ok(r.status === 401 && r.data.error === "bad_password" && typeof r.data.tries_left === "number", "wrong password 401 with tries_left");
r = await call("POST", "/admin/login", { body: { password: vars.OWNER_PASSWORD }, auth: false });
ok(r.status === 204, "login 204");
cookie = r.res.headers.get("set-cookie").split(";")[0];
ok(/^mr_session=/.test(cookie), "session cookie set");
r = await call("POST", "/admin/contracts", { body: {}, headers: { Origin: "https://evil.example" } });
ok(r.status === 403 && r.data.error === "bad_origin", "foreign Origin refused on POST /admin");

// contracts
r = await call("POST", "/admin/contracts", { body: { name: "", folders: ["/"], tasks: ["nope"], dailyLimit: 0 } });
ok(r.status === 422 && r.data.errors.name && r.data.errors.folders && r.data.errors.tasks && r.data.errors.dailyLimit, "invalid contract 422 with field messages");
const dir = "~/mailroom-smoke";
r = await call("POST", "/admin/contracts", { body: { name: "Notes writer", folders: [dir], tasks: ["echo", "read_file", "write_file"], dailyLimit: 50, expires: null, approval: ["write_file"] } });
ok(r.status === 201 && r.data.id && r.data.version === 1, "contract created");
const cid = r.data.id;

// keys
r = await call("POST", "/admin/keys", { body: { label: "", contract_id: cid } });
ok(r.status === 422 && r.data.errors.label, "empty label 422");
r = await call("POST", "/admin/keys", { body: { label: "x".repeat(61), contract_id: cid } });
ok(r.status === 422, "61-char label 422");
r = await call("POST", "/admin/keys", { body: { label: "Dunder Miffbot", contract_id: "c_nope" } });
ok(r.status === 422, "unknown contract 422");
r = await call("POST", "/admin/keys", { body: { label: "Dunder Miffbot", contract_id: cid } });
ok(r.status === 201 && /^mr_live_[0-9A-Za-z]{32}$/.test(r.data.key), "key created, shown once");
const key = r.data.key, kid = r.data.id;
r = await call("GET", "/admin/keys");
ok(r.status === 200 && r.data.find((k) => k.id === kid)?.prefix === key.slice(0, 12) && !JSON.stringify(r.data).includes(key), "key list shows prefix only");

// client auth
r = await call("POST", "/api/jobs", { body: { task: "echo", args: { text: "x" } }, auth: false });
ok(r.status === 401 && r.data.error === "bad_key", "no key 401 bad_key");
r = await call("POST", "/api/jobs", { key: "mrd_" + "a".repeat(32), body: { task: "echo", args: { text: "x" } }, auth: false });
ok(r.status === 401, "daemon-shaped token is not a client key");
r = await call("POST", "/api/jobs", { key, body: { task: "echo", args: { text: "x" } }, auth: false, headers: { Cookie: cookie } });
ok(r.status === 202 && r.data.state === "queued", "cookie plus key: echo queued");
const echoId = r.data.id;
ok(/^p_[0-9a-z]{4,8}$/.test(echoId), "job id shape " + echoId);
r = await call("POST", "/api/jobs", { key, body: { task: "read_file", args: { path: "~/Documents/taxes.pdf" } }, auth: false });
ok(r.status === 403 && r.data.state === "refused" && r.data.reason, "out-of-folder read_file 403 refused with reason");
r = await call("POST", "/api/jobs", { key, body: { task: "echo", args: "nope" }, auth: false });
ok(r.status === 422, "bad args shape 422");
r = await call("POST", "/api/jobs", { key, body: { task: "echo", args: { text: "y".repeat(300 * 1024) } }, auth: false });
ok(r.status === 413, "oversized body 413");
r = await call("POST", "/api/jobs", { key, body: { task: "write_file", args: { path: dir + "/a.txt", content: "hello" } }, auth: false });
ok(r.status === 202 && r.data.state === "waiting_approval", "write_file waits for approval");
const wid = r.data.id;
r = await call("GET", "/admin/state");
ok(r.data.approvals === 1 && r.data.needs_you[0].id === wid && r.data.counts.queued === 1, "state shows approval and queued");

// daemon
r = await call("POST", "/admin/laptop/rotate", { body: {} });
ok(r.status === 200 && /^mrd_/.test(r.data.credential), "daemon credential rotated");
const cred = r.data.credential;
const wsUrl = BASE.replace(/^http/, "ws") + "/daemon";
const bad = await new Promise((res) => { const w = new WebSocket(wsUrl, { headers: { Authorization: `Bearer ${key}` } }); w.on("unexpected-response", (_q, s) => res(s.statusCode)); w.on("error", () => {}); w.on("open", () => res(101)); });
ok(bad === 401, "client key cannot connect as daemon");
const msgs = [];
const ws = new WebSocket(wsUrl, { headers: { Authorization: `Bearer ${cred}` } });
ws.on("message", (d) => { const m = JSON.parse(d.toString()); msgs.push(m); if (m.type === "ping") ws.send(JSON.stringify({ type: "pong" })); });
await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });
ws.send(JSON.stringify({ type: "hello", version: "0.2.0", last_seq: 0 }));
await until(() => msgs.find((m) => m.type === "welcome"), "welcome");
const job1 = await until(() => msgs.find((m) => m.type === "job"), "pushed job");
ok(job1.id === echoId && job1.task === "echo" && job1.contract.name === "Notes writer" && job1.contract_version === 1, "daemon receives the queued echo with its contract");
ws.send(JSON.stringify({ type: "result", id: echoId, ok: true, result: { echo: "x" } }));
r = await until(async () => { const g = await call("GET", `/api/jobs/${echoId}`, { key, auth: false }); return g.data.state === "done" ? g : null; }, "done");
ok(r.data.result.echo === "x", "job done with result");

// approve -> queued -> pushed
r = await call("POST", `/admin/jobs/${wid}/approve`, { body: {} });
ok(r.status === 200 && ["queued", "running"].includes(r.data.state), "approve moves it on");
const job2 = await until(() => msgs.find((m) => m.type === "job" && m.id === wid), "approved job pushed");
ok(job2.task === "write_file", "approved write_file pushed to daemon");
r = await call("POST", `/admin/jobs/${wid}/approve`, { body: {} });
ok(r.status === 409, "approving twice is 409");
ws.send(JSON.stringify({ type: "result", id: wid, ok: false, error: "disk full" }));
r = await until(async () => { const g = await call("GET", `/api/jobs/${wid}`, { key, auth: false }); return g.data.state === "failed" ? g : null; }, "failed");
ok(r.data.reason === "disk full", "daemon failure recorded");

// contract edit applies to queued jobs at once
r = await call("POST", "/api/jobs", { key, body: { task: "echo", args: { text: "later" } }, auth: false });
const laterId = r.data.id;
await until(() => msgs.find((m) => m.type === "job" && m.id === laterId), "later pushed");
ws.send(JSON.stringify({ type: "result", id: laterId, ok: true, result: { echo: "later" } }));
await until(async () => (await call("GET", `/api/jobs/${laterId}`, { key, auth: false })).data.state === "done", "later done");
ws.close(); await sleep(300);
r = await call("POST", "/api/jobs", { key, body: { task: "echo", args: { text: "offline" } }, auth: false });
const offId = r.data.id;
r = await call("GET", "/admin/laptop");
ok(r.data.connected === false && r.data.queue.some((j) => j.id === offId) && /^mrd_\.\.\./.test(r.data.credential_hint), "laptop offline, job waits in queue");
r = await call("PUT", `/admin/contracts/${cid}`, { body: { name: "Notes writer", folders: [dir], tasks: ["read_file"], dailyLimit: 50, expires: null, approval: [] } });
ok(r.status === 200 && r.data.version === 2, "contract edited, version 2");
const ws2msgs = [];
const cred2 = (await call("POST", "/admin/laptop/rotate", { body: {} })).data.credential;
const ws2 = new WebSocket(wsUrl, { headers: { Authorization: `Bearer ${cred2}` } });
ws2.on("message", (d) => ws2msgs.push(JSON.parse(d.toString())));
await new Promise((res, rej) => { ws2.on("open", res); ws2.on("error", rej); });
ws2.send(JSON.stringify({ type: "hello", version: "0.2.0", last_seq: 0 }));
await until(() => ws2msgs.find((m) => m.type === "welcome"), "welcome 2");
await sleep(300);
ok(!ws2msgs.some((m) => m.type === "job"), "queued echo is not pushed after the contract dropped echo");
r = await call("GET", `/api/jobs/${offId}`, { key, auth: false });
ok(r.data.state === "refused" && /not in the contract/.test(r.data.reason), "queued job refused by the edited contract");
const oldDead = await new Promise((res) => { const w = new WebSocket(wsUrl, { headers: { Authorization: `Bearer ${cred}` } }); w.on("unexpected-response", (_q, s) => res(s.statusCode)); w.on("error", () => {}); w.on("open", () => res(101)); });
ok(oldDead === 401, "the rotated-out credential no longer works");
ws2.close();

// another key cannot read this job; revoke
r = await call("POST", "/admin/keys", { body: { label: "Other", contract_id: cid } });
const key2 = r.data.key;
r = await call("GET", `/api/jobs/${echoId}`, { key: key2, auth: false });
ok(r.status === 404, "another key cannot read my job");
r = await call("POST", `/admin/keys/${kid}/revoke`, { body: {} });
ok(r.status === 200 && typeof r.data.cancelled === "number", "key revoked");
r = await call("POST", "/api/jobs", { key, body: { task: "echo", args: { text: "x" } }, auth: false });
ok(r.status === 401 && r.data.error === "bad_key", "revoked key is 401 bad_key");
r = await call("GET", `/api/jobs/${echoId}`, { key, auth: false });
ok(r.status === 401, "revoked key cannot read jobs");

// admin job detail
r = await call("GET", `/admin/jobs/${wid}`);
ok(r.status === 200 && r.data.timeline.length >= 3 && r.data.contract_check && r.data.key.id === kid, "job detail has timeline, contract_check, key");
r = await call("GET", "/admin/jobs?state=done&limit=5");
ok(r.status === 200 && r.data.every((j) => j.state === "done"), "job list filter");

// events: replay in order
r = await call("GET", "/admin/events?after=0");
const all = r.data.events;
ok(all.length > 10 && all.every((e, i) => i === 0 || e.seq > all[i - 1].seq) && r.data.last_seq === all[all.length - 1].seq, "events are ordered");
const kinds = all.map((e) => e.kind);
for (const k of ["key.created", "contract.saved", "job.queued", "job.refused", "job.waiting_approval", "job.approved", "job.running", "job.done", "job.failed", "daemon.connected", "daemon.disconnected", "daemon.rotated", "key.revoked"]) ok(kinds.includes(k), `event ${k} recorded`);
const mid = all[Math.floor(all.length / 2)].seq;
const sse = await fetch(`${BASE}/admin/events/stream?after=${mid}`, { headers: { Cookie: cookie } });
ok(sse.status === 200 && /text\/event-stream/.test(sse.headers.get("content-type")), "SSE opens");
const reader = sse.body.getReader(); let buf = "";
const want = all.filter((e) => e.seq > mid).length;
const t0 = Date.now();
while ((buf.match(/^data: /gm) ?? []).length < want && Date.now() - t0 < 5000) { const { value, done } = await reader.read(); if (done) break; buf += new TextDecoder().decode(value); }
const got = [...buf.matchAll(/^id: (\d+)\ndata: (.*)$/gm)].map((m) => JSON.parse(m[2]).seq);
ok(JSON.stringify(got) === JSON.stringify(all.filter((e) => e.seq > mid).map((e) => e.seq)), "SSE replays events after the cursor, in order");
// live
const liveP = (async () => { let b = ""; for (;;) { const { value, done } = await reader.read(); if (done) return b; b += new TextDecoder().decode(value); if (/job\.|key\./.test(b)) return b; } })();
await call("POST", "/admin/keys", { body: { label: "Live", contract_id: cid } });
ok(/key\.created/.test(await liveP), "SSE delivers a live event");
await reader.cancel();

// logout
r = await call("POST", "/admin/logout", { body: {} });
ok(r.status === 204, "logout 204");
console.log(`\nSMOKE PASSED (${n} checks)`);
process.exit(0);
