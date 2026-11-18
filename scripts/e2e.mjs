// End to end: real wrangler dev + real `mailroom` daemon + real files. Run: node scripts/e2e.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, symlinkSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "../client/mailroom-client.mjs";

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
// Each child runs in its own process group so wrangler and workerd die with it (no orphans holding the port).
const killGroup = p => { try { process.kill(-p.pid, "SIGKILL"); } catch { try { p.kill("SIGKILL"); } catch {} } };
const cleanup = () => { for (const p of procs) killGroup(p); try { rmSync(tmp, { recursive: true, force: true }); } catch {} };
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
const startDaemon = () => { const d = spawn("node", [join(root, "daemon/cli.ts"), "run"], { env: { ...process.env, HOME: home }, stdio: "ignore", detached: true }); procs.push(d); return d; };

console.log("starting wrangler dev ...");
const w = spawn("npx", ["wrangler", "dev", "--port", String(PORT), "--inspector-port", "9351", "--persist-to", join(tmp, "state")], { cwd: root, stdio: "ignore", detached: true });
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
r = await owner("POST", "/admin/contracts", { name: "E2E", folders: [allowed], tasks: ["echo", "read_file", "write_file", "run"], commands: ["greet", "slow"], dailyLimit: 50, expires: null, approval: ["write_file"] });
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
{ // The credential probe must not replace the running daemon.
  const pr = await fetch(`${BASE}/daemon?probe=1`, { headers: { authorization: `Bearer ${cred}` } });
  const pj = await pr.json();
  ok(pr.status === 200 && pj.connected === true, "GET /daemon?probe=1 with the credential says accepted and that a laptop is connected");
  const bad = await fetch(`${BASE}/daemon?probe=1`, { headers: { authorization: "Bearer mrd_" + "x".repeat(32) } });
  ok(bad.status === 401, "a wrong credential on the probe is 401");
  await sleep(1500);
  ok((await owner("GET", "/admin/laptop")).json.connected, "the running daemon is still connected after the probe");
{
  const t = await owner("POST", "/admin/laptop/test");
  ok(t.status === 200 && t.json.ok === true && typeof t.json.ms === "number", "Test connection: the laptop answers a live ping");
}
}

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

console.log("run");
writeFileSync(join(tmp, "greet.sh"), '#!/bin/sh\necho "got:$2"\n', { mode: 0o755 });
mkdirSync(join(home, ".mailroom"), { recursive: true });
writeFileSync(join(home, ".mailroom/commands.json"), JSON.stringify({ greet: { script: join(tmp, "greet.sh"), cwd: allowed, args: { who: { type: "string", required: true, maxLength: 40 } } } }), { mode: 0o600 });
r = await client(key, "POST", "/api/jobs", { task: "run", args: { command: "greet", args: { who: "$(id) world" } } });
ok(r.status === 202, "run accepted");
j = await waitJob(r.json.id, ["done", "failed", "refused"]);
ok(j?.state === "done" && j.result?.output === "got:$(id) world\n" && j.result?.exitCode === 0, "run round trip: metacharacters stay literal");
r = await client(key, "POST", "/api/jobs", { task: "run", args: { command: "rm", args: {} } });
ok(r.status === 403 && r.json.state === "refused", "a command not in the contract is refused at the gateway");
r = await client(key, "POST", "/api/jobs", { task: "run", args: { command: "greet", args: { who: 5 } } });
j = r.status === 403 ? r.json : await waitJob(r.json.id, ["done", "failed", "refused"]);
ok(j?.state === "refused", "bad args are refused by the laptop");

console.log("run: progress, cancel, policy");
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const pids = join(tmp, "slow.pids");
writeFileSync(join(tmp, "slow.sh"), `#!/bin/sh
# tvdash-scan stand-in: reports progress on stderr; "hang" also leaves a grandchild behind
echo "$$" > "${pids}.self"
if [ "$2" = "hang" ]; then
  sleep 300 &
  echo "$!" > "${pids}.grandchild"
  echo "MAILROOM_PROGRESS 25 scanning" >&2
  wait
else
  echo "MAILROOM_PROGRESS 25 scanning" >&2
  sleep 2
  echo "MAILROOM_PROGRESS 75 almost done" >&2
  sleep 2
  echo "scan complete"
fi
`, { mode: 0o755 });
{
  const reg = JSON.parse(readFileSync(join(home, ".mailroom/commands.json"), "utf8"));
  reg.slow = { script: join(tmp, "slow.sh"), cwd: allowed, args: { mode: { type: "enum", values: ["quick", "hang"], required: true } } };
  writeFileSync(join(home, ".mailroom/commands.json"), JSON.stringify(reg), { mode: 0o600 });
}
// The Hub allows 60 requests a minute per key, so this section polls gently and uses its own key.
r = await owner("POST", "/admin/keys", { label: "slow runner", contract_id: contractId });
const slowKey = r.json.key;
const mr = createClient({ url: BASE, key: slowKey });
const untilSlow = async (fn, ms) => until(async () => { await sleep(500); return fn(); }, ms);
const seen = [];
let sub = await mr.submit("run", { command: "slow", args: { mode: "quick" } });
ok(sub.state !== "refused" && !!sub.id, "slow run accepted through the client helper");
const sawRunning = await untilSlow(async () => { const jj = await mr.get(sub.id); if (jj.progress) seen.push({ state: jj.state, ...jj.progress }); return jj.state === "running" && jj.progress ? jj : null; }, 20000);
ok(sawRunning?.progress?.text === "scanning" && sawRunning.progress.pct === 25, "progress text and pct show while the job is running");
j = await mr.wait(sub.id, { intervalMs: 1000, timeoutMs: 30000, onProgress: p => seen.push(p) });
ok(j.state === "done" && j.result?.output === "scan complete\n", "slow run ends done with its output");
ok(seen.some(p => p.text === "almost done" && p.pct === 75), "a later progress update (75 almost done) was seen");

sub = await mr.submit("run", { command: "slow", args: { mode: "hang" } });
await untilSlow(async () => (await mr.get(sub.id)).progress, 20000);
const readPid = f => { try { return Number(readFileSync(`${pids}.${f}`, "utf8").trim()); } catch { return NaN; } };
const selfPid = readPid("self"), grandPid = readPid("grandchild");
ok(alive(selfPid) && alive(grandPid), "the hanging script and its grandchild are running");
const nextJob = await mr.submit("echo", { text: "after cancel" });
const cr = await mr.cancel(sub.id);
ok(cr.state === "cancelled", "cancel answers cancelled");
ok((await mr.get(sub.id)).state === "cancelled", "the job reads back cancelled");
ok(await until(async () => !alive(selfPid) && !alive(grandPid), 10000), "the job's process and its grandchild are gone");
j = await mr.wait(nextJob.id, { intervalMs: 1000, timeoutMs: 20000 });
ok(j.state === "done" && j.result?.echo === "after cancel", "the daemon takes the next job after the cancel");
ok((await mr.get(sub.id)).state === "cancelled", "the cancelled job stays cancelled");

// The laptop policy ceiling: a contract that allows a command the policy does not list is refused by the daemon.
mkdirSync(join(home, ".mailroom"), { recursive: true });
writeFileSync(join(home, ".mailroom/policy.json"), JSON.stringify({ folders: [allowed], tasks: ["echo", "read_file", "write_file", "run"], commands: ["greet", "slow"] }), { mode: 0o600 });
r = await mr.submit("run", { command: "greet", args: { who: "policy" } });
j = await mr.wait(r.id, { intervalMs: 1000, timeoutMs: 20000 });
ok(j?.state === "done", "within the policy, a run still works");
r = await owner("POST", "/admin/contracts", { name: "Too wide", folders: [allowed], tasks: ["run"], commands: ["greet", "rm-everything"], dailyLimit: 50, expires: null, approval: [] });
const wideContract = r.json.id;
r = await owner("POST", "/admin/keys", { label: "wide", contract_id: wideContract });
const wide = createClient({ url: BASE, key: r.json.key });
r = await wide.submit("run", { command: "greet", args: { who: "x" } });
ok(r.state === "queued" || r.state === "running" || r.state === "dispatched", `the Hub accepts it (greet is in that contract): ${r.state}`);
j = await wide.wait(r.id, { intervalMs: 1000, timeoutMs: 20000 });
ok(j?.state === "refused" && /rm-everything/.test(j.reason || "") && /policy/.test(j.reason || ""), `the daemon refuses: ${j?.reason}`);

console.log("offline queue");
killGroup(d);
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

console.log("overview counts");
r = await owner("GET", "/admin/state");
ok(r.json.counts.done === 8 && r.json.counts.refused === 5 && r.json.counts.queued === 0, `today's counts are true (done ${r.json.counts.done}, refused ${r.json.counts.refused}, queued ${r.json.counts.queued})`);
ok(r.json.daemon.connected === true, "overview says the laptop is connected");

console.log("events");
r = await owner("GET", "/admin/events?after=0&limit=500");
const kinds = new Set(r.json.events.map(e => e.kind));
for (const k of ["key.created", "key.revoked", "contract.saved", "job.refused", "job.done", "daemon.connected", "daemon.disconnected", "daemon.rotated"]) ok(kinds.has(k), `event ${k} recorded`);
const seqs = r.json.events.map(e => e.seq);
ok(seqs.every((s, i) => i === 0 || s > seqs[i - 1]), "events are in order");
{ // The Events page loads the LATEST events (tail), not the first ones.
  const first = (await owner("GET", "/admin/events?after=0&limit=3")).json;
  const tail = (await owner("GET", "/admin/events?after=0&limit=3&tail=1")).json;
  ok(first.events.map(e => e.seq).join() === "1,2,3", "without tail, limit=3 gives the first three events (replay)");
  ok(tail.events.length === 3 && tail.events.at(-1).seq === tail.last_seq && tail.events[0].seq === tail.last_seq - 2 && tail.events.every((e, i, a) => i === 0 || e.seq > a[i - 1].seq), "with tail=1, limit=3 gives the latest three, oldest first");
}

console.log(failed ? `\nE2E FAILED (${failed})` : "\nE2E PASSED");
process.exit(failed ? 1 : 0);
