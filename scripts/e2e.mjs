// End to end: real wrangler dev + real `mailroom` daemon + real files. Run: node scripts/e2e.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, symlinkSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "../client/mailroom-client.mjs";

const PORT = Number(process.env.E2E_PORT) || 8801; // E2E_PORT lets two runs coexist
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
const w = spawn("npx", ["wrangler", "dev", "--port", String(PORT), "--inspector-port", String(PORT + 550), "--persist-to", join(tmp, "state")], { cwd: root, stdio: "ignore", detached: true });
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

// Lanes: a long job (the slow script has the default 5 minute timeout, so it is `long`) must not block a short echo.
console.log("lanes: long does not block short");
const longJob = await mr.submit("run", { command: "slow", args: { mode: "hang" } });
await untilSlow(async () => (await mr.get(longJob.id)).state === "running", 20000);
const longSelf = readPid("self"), longGrand = readPid("grandchild");
const shortJob = await mr.submit("echo", { text: "beside the long one" });
j = await mr.wait(shortJob.id, { intervalMs: 1000, timeoutMs: 15000 });
ok(j.state === "done" && j.result?.echo === "beside the long one", "a short echo finishes while the long job is still running");
ok((await mr.get(longJob.id)).state === "running", "the long job is still running after the short one finished");
const behind = await mr.submit("run", { command: "slow", args: { mode: "quick" } });
await sleep(1500);
ok((await mr.get(behind.id)).state === "queued", "a second long job waits its turn (one job per lane)");
const cl = await mr.cancel(longJob.id);
ok(cl.state === "cancelled", "cancel of the long job answers cancelled");
ok(await until(async () => !alive(longSelf) && !alive(longGrand), 10000), "the cancelled long job's process tree is gone");
const afterCancel = await mr.submit("echo", { text: "short lane after cancel" });
j = await mr.wait(afterCancel.id, { intervalMs: 1000, timeoutMs: 15000 });
ok(j.state === "done" && j.result?.echo === "short lane after cancel", "the short lane keeps working after the long one is cancelled");
j = await mr.wait(behind.id, { intervalMs: 1000, timeoutMs: 30000 });
ok(j.state === "done", "the queued long job runs once its lane is free");

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

// A key whose contract allows only web tools and 6 turns cannot run a claude job asking for a shell tool or more turns.
r = await owner("POST", "/admin/contracts", { name: "Web only", folders: [allowed], tasks: ["claude"], claudeTools: ["WebFetch", "WebSearch"], claudeMaxTurns: 6, dailyLimit: 50, expires: null, approval: [] });
ok(r.status === 201 && r.json.claudeMaxTurns === 6 && r.json.claudeTools?.length === 2, "contract with claude ceilings created");
const webContract = r.json.id;
r = await owner("POST", "/admin/keys", { label: "web only", contract_id: webContract });
const webKey = r.json.key;
r = await client(webKey, "POST", "/api/jobs", { task: "claude", args: { prompt: "x", cwd: allowed, allowedTools: ["Bash"] } });
ok(r.status === 403 && r.json.state === "refused" && /Bash/.test(r.json.reason || ""), `a shell tool is refused at the gateway: ${r.json.reason}`);
r = await client(webKey, "POST", "/api/jobs", { task: "claude", args: { prompt: "x", cwd: allowed, maxTurns: 50 } });
ok(r.status === 403 && r.json.state === "refused" && /maxTurns 50/.test(r.json.reason || ""), `50 turns is refused at the gateway: ${r.json.reason}`);

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
ok(r.json.counts.done === 11 && r.json.counts.refused === 7 && r.json.counts.queued === 0, `today's counts are true (done ${r.json.counts.done}, refused ${r.json.counts.refused}, queued ${r.json.counts.queued})`);
ok(r.json.daemon.connected === true, "overview says the laptop is connected");

console.log("projects");
r = await owner("POST", "/admin/projects", { name: "  " });
ok(r.status === 422 && r.json.errors?.name, "a blank project name is 422 with a field error");
r = await owner("POST", "/admin/projects", { name: "x".repeat(61) });
ok(r.status === 422 && r.json.errors?.name, "a 61-character project name is 422");
r = await owner("POST", "/admin/projects", { name: "E2E app", folder: "~/Hobby/e2e", notes: "n" });
ok(r.status === 201 && r.json.id?.startsWith("pr_") && r.json.key_count === 0, "project created");
const projId = r.json.id;
r = await owner("POST", "/admin/projects", { name: "e2e APP" });
ok(r.status === 422 && r.json.errors?.name, "a duplicate name is refused while the first is live");
r = await owner("PATCH", `/admin/keys/${(await owner("GET", "/admin/keys")).json.find(k => k.label === "e2e client").id}`, { project_id: "pr_nope" });
ok(r.status === 422 && r.json.errors?.project_id, "moving a key into an unknown project is 422");
const e2eKeyId = (await owner("GET", "/admin/keys")).json.find(k => k.label === "e2e client").id;
r = await owner("PATCH", `/admin/keys/${e2eKeyId}`, { project_id: projId });
ok(r.status === 200 && r.json.project_id === projId, "the e2e key moves into the project");
r = await owner("GET", `/admin/projects/${projId}`);
ok(r.status === 200 && r.json.keys.some(k => k.id === e2eKeyId) && r.json.key_count === 1, "the project page lists the key");
ok(Array.isArray(r.json.recent_jobs) && r.json.recent_jobs.length > 0 && r.json.today.done > 0, "the project page carries the key's jobs and today's counts");
ok(r.json.commands.rows.some(c => c.name === "slow"), "the commands view lists a contract command");
r = await owner("POST", `/admin/projects/${projId}/archive`);
ok(r.status === 409 && r.json.error === "has_active_keys" && r.json.count === 1, "archive is refused while it has an active key, with the count");
r = await owner("GET", "/admin/projects");
ok(r.json.some(p => p.id === "unassigned") && r.json.find(p => p.id === projId).key_count === 1, "the list has the project and the Unassigned entry");
r = await owner("PATCH", `/admin/keys/${e2eKeyId}`, { project_id: null });
ok(r.status === 200 && r.json.project_id === null, "the key moves back to Unassigned");
r = await owner("PATCH", `/admin/keys/${e2eKeyId}`, { project_id: projId });
ok(r.json.project_id === projId, "and into the project again");
r = await owner("POST", "/admin/keys", { label: "in project", contract_id: contractId, project_id: projId });
ok(r.status === 201, "a key can be issued straight into a project");
await owner("POST", `/admin/keys/${r.json.id}/revoke`);

r = await owner("POST", "/admin/contracts", { name: "Ghost", folders: [allowed], tasks: ["run"], commands: ["greet", "ghost"], dailyLimit: 50, expires: null, approval: [] });
const ghostContract = r.json.id;
r = await owner("POST", "/admin/keys", { label: "ghost holder", contract_id: ghostContract, project_id: projId });
const ghostKey = r.json.key;
const ghostKeyId = r.json.id;

// A fresh daemon says hello with the registry (greet is registered by now), replacing the old connection.
killGroup(d);
d = startDaemon();
r = await until(async () => { const x = await client(key, "GET", "/api/commands"); return x.json?.find?.(c => c.name === "greet")?.on_laptop ? x : null; });
ok(r?.status === 200, "GET /api/commands says greet is on the laptop after the daemon's hello");
ok(r && r.json.find(c => c.name === "greet").args.who?.type === "string" && r.json.find(c => c.name === "greet").args.who.required === true, "it carries the full arg spec");
const gr = await client(ghostKey, "GET", "/api/commands");
ok(gr.json.find(c => c.name === "ghost").on_laptop === false && gr.json.find(c => c.name === "ghost").args === null && gr.json.find(c => c.name === "ghost").timeoutMs === null, "a contract command the laptop did not report is on_laptop false, args null");
ok(r && !JSON.stringify(r.json).includes("greet.sh") && !JSON.stringify(r.json).includes(allowed), "no script path or cwd is reported");
ok((await client("mr_live_" + "x".repeat(32), "GET", "/api/commands")).status === 401, "/api/commands needs a client key");
r = await owner("GET", `/admin/projects/${projId}`);
ok(r.json.laptop_reported_at > 0 && r.json.commands.reported === true && r.json.commands.rows.find(c => c.name === "ghost")?.mismatch === "not-on-laptop", "the project page shows a mismatch for a command the laptop lacks");
await owner("PATCH", `/admin/keys/${e2eKeyId}`, { project_id: null });
await owner("POST", `/admin/keys/${ghostKeyId}/revoke`);
r = await owner("POST", `/admin/projects/${projId}/archive`);
ok(r.status === 200 && r.json.archived_at > 0, "archive works once it has no active keys");
r = await owner("PATCH", `/admin/keys/${e2eKeyId}`, { project_id: projId });
ok(r.status === 422, "a key cannot be moved into an archived project");
r = await owner("POST", "/admin/projects", { name: "E2E app" });
ok(r.status === 201, "a name is free again once its project is archived");
r = await owner("POST", `/admin/projects/${projId}/unarchive`);
ok(r.status === 409, "unarchive is refused when its name is taken");
r = await owner("GET", "/admin/events?after=0&limit=1000");
{ const ks = new Set(r.json.events.map(e => e.kind)); for (const k of ["project.created", "project.archived", "key.moved"]) ok(ks.has(k), `event ${k} recorded`); ok(!r.json.events.some(e => e.kind === "mcp.call" && e.payload.tool === "commands"), "listing commands is not an event"); }

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

// ---- daily limit, idempotency, labels, big results, re-run safety ----
console.log("cancelled parcels do not count toward the daily limit");
r = await owner("POST", "/admin/contracts", { name: "Limit 2", folders: [allowed], tasks: ["write_file"], dailyLimit: 2, expires: null, approval: ["write_file"] });
r = await owner("POST", "/admin/keys", { label: "limit key", contract_id: r.json.id });
const limKey = r.json.key;
const wf = () => client(limKey, "POST", "/api/jobs", { task: "write_file", args: { path: join(allowed, "never.txt"), content: "x" } });
const w1 = await wf();
const w2 = await wf();
ok(w1.json.state === "waiting_approval" && w2.json.state === "waiting_approval", "two parcels use the limit of 2");
r = await wf();
ok(r.status === 403 && /daily limit/.test(r.json.reason), "a third is refused by the limit");
r = await client(limKey, "POST", `/api/jobs/${w1.json.id}/cancel`);
ok(r.json.state === "cancelled", "one parcel is cancelled");
r = await wf();
ok(r.status === 202 && r.json.state === "waiting_approval", "after the cancel there is room again (cancelled parcels do not count)");

console.log("idempotency key");
r = await owner("POST", "/admin/contracts", { name: "V05", folders: [allowed], tasks: ["echo", "read_file", "run"], commands: ["slow", "slowsafe"], dailyLimit: 500, expires: null, approval: [] });
const v5Contract = r.json.id;
r = await owner("POST", "/admin/keys", { label: "v05 key", contract_id: v5Contract });
const v5 = r.json.key;
writeFileSync(join(home, ".mailroom/policy.json"), JSON.stringify({ folders: [allowed], tasks: ["echo", "read_file", "write_file", "run"], commands: ["greet", "slow", "slowsafe"] }), { mode: 0o600 }); // the laptop ceiling now also lists slowsafe
const post = async (k, body, headers = {}) => {
  const rr = await fetch(BASE + "/api/jobs", { method: "POST", headers: { authorization: `Bearer ${k}`, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { status: rr.status, json: await rr.json() };
};
const i1 = await post(v5, { task: "echo", args: { text: "once" } }, { "idempotency-key": "same-1" });
ok(i1.status === 202 && !!i1.json.id, "first submit with an Idempotency-Key is accepted");
const i2 = await post(v5, { task: "echo", args: { text: "once" } }, { "idempotency-key": "same-1" });
ok((i2.status === 200 || i2.status === 202) && i2.json.id === i1.json.id, `a repeat returns the same job (${i2.status}, ${i2.json.id})`);
const i3 = await post(v5, { args: { text: "once" }, task: "echo" }, { "idempotency-key": "same-1" });
ok(i3.json.id === i1.json.id, "key order in the body does not matter");
const i4 = await post(v5, { task: "echo", args: { text: "different" } }, { "idempotency-key": "same-1" });
ok(i4.status === 409 && i4.json.error === "idempotency_conflict", "different args under the same key is 409");
const i5 = await post(v5, { task: "echo", args: { text: "once" } }, { "idempotency-key": "same-2" });
ok(i5.json.id && i5.json.id !== i1.json.id, "another key makes a new job");
const i6 = await post(v5, { task: "echo", args: { text: "once" } });
ok(i6.json.id && i6.json.id !== i1.json.id && i6.json.id !== i5.json.id, "no key: always a new job");
const i7 = await post(v5, { task: "echo", args: { text: "once" } }, { "idempotency-key": "bad key with spaces" });
ok(i7.status === 422 && !!i7.json.errors?.idempotency_key, "an invalid key is 422");
const mrv5 = createClient({ url: BASE, key: v5 });
const c1 = await mrv5.submit("echo", { text: "via client" }, { idempotency: "client-1" });
const c2 = await mrv5.submit("echo", { text: "via client" }, { idempotency: "client-1" });
ok(c1.id === c2.id, "the client helper's {idempotency} option works");
j = await mrv5.wait(i1.json.id, { intervalMs: 1000, timeoutMs: 20000 });
ok(j.state === "done", "and the job ran once");
r = await owner("GET", "/admin/events?after=0&limit=1000");
ok(r.json.events.filter(e => e.kind === "job.done" && e.payload.job_id === i1.json.id).length === 1, "exactly one job.done event for it");

console.log("labels");
const l1 = await mrv5.submit("echo", { text: "labelled" }, { label: "abilities test" });
ok(!!l1.id, "a labelled parcel is accepted");
const lj = await mrv5.wait(l1.id, { intervalMs: 1000, timeoutMs: 20000 });
ok(lj.label === "abilities test", "GET /api/jobs/:id returns the label");
const mk = await mrv5.submit("echo", { text: "markup" }, { label: "<img src=x onerror=alert(1)>" });
ok(mk.id, "markup in a label is stored as text");
r = await post(v5, { task: "echo", args: { text: "x" }, label: "x".repeat(61) });
ok(r.status === 422 && !!r.json.errors?.label, "a label over 60 characters is 422");
r = await post(v5, { task: "echo", args: { text: "x" }, label: "" });
ok(r.status === 422, "an empty label is 422");
r = await owner("GET", "/admin/parcels?label=" + encodeURIComponent("abilities test"));
ok(r.status === 200 && r.json.length === 1 && r.json[0].id === l1.id && r.json[0].label === "abilities test", "GET /admin/parcels?label= filters by label");
r = await owner("GET", "/admin/jobs?label=" + encodeURIComponent("abilities test") + "&state=done");
ok(r.json.length === 1, "/admin/jobs takes the same filter, combined with state");
r = await owner("GET", `/admin/jobs/${mk.id}`);
ok(r.json.label === "<img src=x onerror=alert(1)>", "the admin job view returns the label verbatim (the UI shows it as text)");
r = await owner("GET", "/admin/jobs?limit=500");
ok(r.json.find(x => x.id === i1.json.id)?.label === undefined, "an unlabelled parcel has no label");

console.log("big results");
const big1 = "y".repeat(1024 * 1024);
writeFileSync(join(allowed, "big1m.txt"), big1);
writeFileSync(join(allowed, "big3m.txt"), "z".repeat(3 * 1024 * 1024));
r = await mrv5.submit("read_file", { path: join(allowed, "big1m.txt") });
j = await mrv5.wait(r.id, { intervalMs: 1000, timeoutMs: 30000 });
ok(j.state === "done" && j.result?.content === big1, "a 1 MB file comes back whole through GET /api/jobs/:id");
r = await owner("GET", `/admin/jobs/${r.id}`);
ok(r.json.result?.content === big1, "the admin job view has the full result");
r = await owner("GET", "/admin/jobs?limit=50");
const bigRow = r.json.find(x => x.result?.$stored);
ok(bigRow && bigRow.result.$stored.bytes > 1024 * 1024 && !JSON.stringify(bigRow).includes("yyyy"), "lists show a small stored-result marker, not the megabyte");
r = await mrv5.submit("read_file", { path: join(allowed, "big3m.txt") });
j = await mrv5.wait(r.id, { intervalMs: 1000, timeoutMs: 30000 });
ok(j.state === "failed" && /bigger than 2 MB/.test(j.reason || ""), `over the 2 MB cap fails in words: ${j.reason}`);

console.log("re-run safety");
{
  const reg = JSON.parse(readFileSync(join(home, ".mailroom/commands.json"), "utf8"));
  reg.slowsafe = { ...reg.slow, rerunSafe: true };
  writeFileSync(join(home, ".mailroom/commands.json"), JSON.stringify(reg), { mode: 0o600 });
}
r = await owner("POST", "/admin/keys", { label: "rerun key", contract_id: v5Contract }); // its own key: the rate limit is 60 a minute
const mrr = createClient({ url: BASE, key: r.json.key });
const reap = () => { for (const f of ["self", "grandchild"]) { try { process.kill(Number(readFileSync(`${pids}.${f}`, "utf8").trim()), "SIGKILL"); } catch {} } };
const dropLaptop = async () => {
  killGroup(d);
  reap();
  return until(async () => !(await owner("GET", "/admin/laptop")).json.connected, 90000);
};
const untilRunning = async id => until(async () => { await sleep(1500); const g = await mrr.get(id); return g.state === "running" && g.progress ? g : null; }, 30000);
await dropLaptop();
d = startDaemon(); // its hello now lists slowsafe as rerunSafe
ok(await until(async () => (await owner("GET", "/admin/laptop")).json.connected), "daemon reconnected, reporting rerunSafe in its hello");
const unsafe = await mrr.submit("run", { command: "slow", args: { mode: "hang" } });
ok(!!(await untilRunning(unsafe.id)), "a non-re-run-safe command is running");
ok(await dropLaptop(), "the laptop drops mid-run");
j = await mrr.get(unsafe.id);
ok(j.state === "failed" && j.reason === "laptop dropped mid-run; not re-run-safe", `it is not run again: ${j.state} (${j.reason})`);
d = startDaemon();
ok(await until(async () => (await owner("GET", "/admin/laptop")).json.connected), "daemon back");
await sleep(2000);
j = await mrr.get(unsafe.id);
ok(j.state === "failed", "and it stays failed after the laptop returns");
const safe = await mrr.submit("run", { command: "slowsafe", args: { mode: "hang" } });
ok(!!(await untilRunning(safe.id)), "a re-run-safe command is running");
ok(await dropLaptop(), "the laptop drops again");
j = await mrr.get(safe.id);
ok(j.state === "queued", `a re-run-safe job goes back to the queue: ${j.state}`);
d = startDaemon();
ok(!!(await untilRunning(safe.id)), "and it runs again when the laptop returns");
await mrr.cancel(safe.id);
ok(await until(async () => (await mrr.get(safe.id)).state === "cancelled"), "cancelled to clean up");
reap();

console.log(failed ? `\nE2E FAILED (${failed})` : "\nE2E PASSED");
process.exit(failed ? 1 : 0);
