// End to end: real wrangler dev + real `mailroom` daemon + real files. Run: node scripts/e2e.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, symlinkSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 8801;
const BASE = `http://localhost:${PORT}`;
const root = new URL("..", import.meta.url).pathname;
const pass = readFileSync(join(root, ".dev.vars"), "utf8").match(/^OWNER_PASSWORD=(.*)$/m)[1];
const tmp = mkdtempSync(join(tmpdir(), "mr-e2e-"));
const allowed = join(tmp, "allowed");
const outside = join(tmp, "outside");
mkdirSync(allowed);
mkdirSync(outside);
writeFileSync(join(outside, "secret.txt"), "top secret");
symlinkSync(outside, join(allowed, "escape"));
writeFileSync(join(allowed, "hello.txt"), "hello from the laptop");
const home = join(tmp, "home");
mkdirSync(home);

const procs = [];
let failed = 0;
const ok = (c, m) => { if (c) console.log(`  ok   ${m}`); else { failed++; console.log(`  FAIL ${m}`); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cleanup = () => { for (const p of procs) try { p.kill("SIGKILL"); } catch {} try { rmSync(tmp, { recursive: true, force: true }); } catch {} };
process.on("exit", cleanup);

let cookie = "";
const owner = async (method, path, body) => {
  const r = await fetch(BASE + path, { method, headers: { cookie, "content-type": "application/json", origin: BASE }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text();
  return { status: r.status, json: t ? JSON.parse(t) : null, headers: r.headers };
};
const client = async (key, method, path, body) => {
  const r = await fetch(BASE + path, { method, headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text();
  return { status: r.status, json: t ? JSON.parse(t) : null };
};
async function until(fn, ms = 15000) { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(200); } return null; }
const startDaemon = () => { const d = spawn("node", [join(root, "daemon/cli.ts"), "run"], { env: { ...process.env, HOME: home }, stdio: "ignore" }); procs.push(d); return d; };

console.log("starting wrangler dev ...");
const w = spawn("npx", ["wrangler", "dev", "--port", String(PORT), "--inspector-port", "9351", "--persist-to", join(tmp, "state")], { cwd: root, stdio: "ignore" });
procs.push(w);
if (!(await until(async () => { try { return (await fetch(BASE + "/admin/state")).status === 401; } catch { return false; } }, 60000))) { console.log("FAIL wrangler did not start"); process.exit(1); }

console.log("signed out");
for (const p of ["/login", "/css/app.css", "/js/login.js", "/js/theme-init.js", "/js/theme.js", "/js/dom.js", "/favicon.svg"]) {
  const pr = await fetch(BASE + p, { redirect: "manual" });
  ok(pr.status === 200, `the sign-in page can load ${p}`);
}
for (const p of ["/", "/index.html", "/js/app.js", "/js/api.js", "/js/pages/keys.js"]) {
  const pr = await fetch(BASE + p, { redirect: "manual" });
  ok(pr.status === 302 && pr.headers.get("location") === "/login", `${p} stays behind the login`);
}

console.log("owner");
let r = await fetch(BASE + "/admin/login", { method: "POST", headers: { "content-type": "application/json", origin: BASE }, body: JSON.stringify({ password: "wrong" }) });
ok(r.status === 401, "wrong password is 401");
r = await fetch(BASE + "/admin/login", { method: "POST", headers: { "content-type": "application/json", origin: BASE }, body: JSON.stringify({ password: pass }) });
ok(r.status === 204, "login is 204");
cookie = (r.headers.get("set-cookie") || "").split(";")[0];
ok(/^mr_session=/.test(cookie), "session cookie set");
r = await owner("POST", "/admin/keys", { label: "x", contract_id: "nope" });
ok(r.status === 422, "key with unknown contract is 422");

console.log("contract, key, credential");
r = await owner("POST", "/admin/contracts", { name: "E2E", folders: [allowed], tasks: ["echo", "read_file", "write_file"], dailyLimit: 50, expires: null, approval: ["write_file"] });
ok(r.status === 201, "contract created");
const contractId = r.json.id;
r = await owner("POST", "/admin/keys", { label: "e2e client", contract_id: contractId });
ok(r.status === 201 && r.json.key?.startsWith("mr_live_"), "key issued once");
const key = r.json.key;
r = await owner("GET", `/admin/keys`);
ok(!JSON.stringify(r.json).includes(key), "the full key is not listed again");
r = await owner("POST", "/admin/laptop/rotate");
const cred = r.json.credential;
ok(cred?.startsWith("mrd_"), "daemon credential issued");

console.log("daemon login");
const login = spawn("node", [join(root, "daemon/cli.ts"), "login", "--url", BASE, "--credential", cred], { env: { ...process.env, HOME: home }, stdio: "pipe" });
let out = "";
login.stdout.on("data", d => (out += d));
await new Promise(res => login.on("exit", res));
ok(!out.includes(cred), "login never prints the credential");
let d = startDaemon();
ok(await until(async () => (await owner("GET", "/admin/laptop")).json.connected), "daemon connected");

console.log("jobs");
const waitJob = async (id, states) => until(async () => { const j = (await client(key, "GET", `/api/jobs/${id}`)).json; return states.includes(j.state) ? j : null; });
r = await client(key, "POST", "/api/jobs", { task: "echo", args: { text: "hi" } });
ok(r.status === 202, "echo accepted");
let j = await waitJob(r.json.id, ["done", "failed", "refused"]);
ok(j?.state === "done" && j.result?.echo === "hi", "echo round trip through the real daemon");

r = await client(key, "POST", "/api/jobs", { task: "read_file", args: { path: join(allowed, "hello.txt") } });
j = await waitJob(r.json.id, ["done", "failed", "refused"]);
ok(j?.state === "done" && j.result?.content === "hello from the laptop", "read_file inside the folder");

r = await client(key, "POST", "/api/jobs", { task: "read_file", args: { path: join(outside, "secret.txt") } });
ok(r.status === 403 && r.json.state === "refused", "outside path refused at the gateway");

r = await client(key, "POST", "/api/jobs", { task: "read_file", args: { path: join(allowed, "escape", "secret.txt") } });
j = r.status === 403 ? r.json : await waitJob(r.json.id, ["done", "failed", "refused"]);
ok(j?.state === "refused" && !JSON.stringify(j).includes("top secret"), "symlink escape is refused (the daemon's own check) and nothing leaks");

r = await client(key, "POST", "/api/jobs", { task: "write_file", args: { path: join(allowed, "note.md"), content: "approved text" } });
ok(r.status === 202 && r.json.state === "waiting_approval", "write_file waits for approval");
await sleep(500);
ok(!existsSync(join(allowed, "note.md")), "nothing written before approval");
const approve = await owner("POST", `/admin/jobs/${r.json.id}/approve`);
ok([200, 202, 204].includes(approve.status), "owner approves");
j = await waitJob(r.json.id, ["done", "failed", "refused"]);
ok(j?.state === "done" && readFileSync(join(allowed, "note.md"), "utf8") === "approved text", "write runs after approval and the file is on disk");

console.log("offline queue");
d.kill("SIGKILL");
ok(await until(async () => !(await owner("GET", "/admin/laptop")).json.connected, 90000), "laptop shows away after the daemon dies");
r = await client(key, "POST", "/api/jobs", { task: "echo", args: { text: "later" } });
ok(r.json.state === "queued", "job queues while the laptop is away");
const queued = (await owner("GET", "/admin/laptop")).json.queue;
ok(queued.some(q => q.id === r.json.id), "it shows in the laptop queue");
d = startDaemon();
j = await waitJob(r.json.id, ["done", "failed", "refused"]);
ok(j?.state === "done" && j.result?.echo === "later", "it runs when the laptop returns");

console.log("revoke");
r = await owner("POST", `/admin/keys`, { label: "to revoke", contract_id: contractId });
const k2 = r.json.key;
await owner("POST", `/admin/keys/${r.json.id}/revoke`);
r = await client(k2, "POST", "/api/jobs", { task: "echo", args: { text: "x" } });
ok(r.status === 401, "a revoked key stops at once");

console.log("events");
r = await owner("GET", "/admin/events?after=0&limit=500");
const kinds = new Set(r.json.events.map(e => e.kind));
for (const k of ["key.created", "key.revoked", "contract.saved", "job.refused", "job.done", "daemon.connected", "daemon.disconnected", "daemon.rotated"]) ok(kinds.has(k), `event ${k} recorded`);
const seqs = r.json.events.map(e => e.seq);
ok(seqs.every((s, i) => i === 0 || s > seqs[i - 1]), "events are in order");

console.log(failed ? `\nE2E FAILED (${failed})` : "\nE2E PASSED");
process.exit(failed ? 1 : 0);
