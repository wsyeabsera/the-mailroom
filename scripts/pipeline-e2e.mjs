// End to end for pipelines: real wrangler dev + real `mailroom` daemon. A project registers a workflow on the "laptop" (files in a temporary HOME only;
// no Mailroom code is touched): a script lists items, a batch asks Claude about each one three at a time, a script checks the answers.
// Claude itself is a fake `claude` on the daemon's PATH. Proves: partial results arrive while the job runs, `n of N` progress, three at a time,
// the Claude budget holds, the policy and contract apply to every step, and cancel stops it.
// Run: E2E_PORT=8851 node scripts/pipeline-e2e.mjs   (a unique E2E_PORT per run; this never touches ~/.mailroom or the owner's service)
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "../client/mailroom-client.mjs";

const PORT = Number(process.env.E2E_PORT) || 8851;
const BASE = `http://localhost:${PORT}`;
const root = new URL("..", import.meta.url).pathname;
const pass = readFileSync(join(root, ".dev.vars"), "utf8").match(/^OWNER_PASSWORD=(.*)$/m)[1];
const tmp = mkdtempSync(join(tmpdir(), "mr-pipe-"));
const allowed = join(tmp, "project");
const home = join(tmp, "home");
const bin = join(tmp, "bin");
const claudeLog = join(tmp, "claude.log");
for (const d of [allowed, home, bin, join(home, ".mailroom")]) mkdirSync(d, { recursive: true });

const procs = [];
let failed = 0;
const ok = (c, m) => { if (c) console.log(`  ok   ${m}`); else { failed++; console.log(`  FAIL ${m}`); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const killGroup = p => { try { process.kill(-p.pid, "SIGKILL"); } catch { try { p.kill("SIGKILL"); } catch {} } };
const cleanup = () => { for (const p of procs) killGroup(p); try { rmSync(tmp, { recursive: true, force: true }); } catch {} };
process.on("exit", cleanup);
async function until(fn, ms = 20000) { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(150); } return null; }

let cookie = "";
const owner = async (method, path, body) => {
  const r = await fetch(BASE + path, { method, headers: { cookie, "content-type": "application/json", origin: BASE }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text();
  return { status: r.status, json: t ? JSON.parse(t) : null };
};

// ---- the "project": its own scripts, prompt and workflow, registered on the laptop (neutral names) ----
const script = (name, body) => { const f = join(tmp, name); writeFileSync(f, `#!/bin/sh\n${body}\n`, { mode: 0o755 }); return f; };
const N = 9;
const names = Array.from({ length: N }, (_, i) => `item-${i + 1}`);
const listItems = script("list-items.sh", `for i in 1 2 3 4 5 6 7 8 9; do\n  echo "MAILROOM_PROGRESS listing $i" >&2\n  echo "MAILROOM_PARTIAL {\\"listed\\":$i}" >&2\n  sleep 0.3\ndone\necho '{"items":${JSON.stringify(names)}}'`);
const checkAnswers = script("check-answers.sh", `node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=JSON.parse(s);console.log(JSON.stringify({seen:a.length,answered:a.filter(x=>x.ok&&/^ANSWER /.test(x.value)).length,failed:a.filter(x=>!x.ok).length}))})'`);
// fake claude: it takes 1.2 s, uses 2 turns (never more than --max-turns, like the real one), answers "ANSWER <item>"; logs starts and ends so the test can see how many ran at once
writeFileSync(join(bin, "claude"), `#!/usr/bin/env node
const fs = require("node:fs");
const a = process.argv.slice(2), prompt = a[a.length - 1];
const log = s => fs.appendFileSync(${JSON.stringify(claudeLog)}, s + "\\n");
const item = (/Review "([^"]*)"/.exec(prompt) || [])[1];
log("start " + item + " " + Date.now());
console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "thinking" }] } }));
setTimeout(() => { log("end " + item + " " + Date.now()); console.log(JSON.stringify({ type: "result", num_turns: Math.min(2, Number(a[a.indexOf("--max-turns") + 1])), result: "ANSWER " + item, session_id: "p-" + process.pid })); }, 1200);
`, { mode: 0o755 });

writeFileSync(join(home, ".mailroom/commands.json"), JSON.stringify({
  "list-items": { script: listItems, cwd: allowed, args: {}, timeoutMs: 60000 },
  "check-answers": { script: checkAnswers, cwd: allowed, args: {}, timeoutMs: 60000 },
}), { mode: 0o600 });
writeFileSync(join(home, ".mailroom/prompts.json"), JSON.stringify({
  "review-item": { template: "Review {item}", vars: { item: { type: "string", required: true, maxLength: 60 } }, tools: ["Read"], maxTurns: 8, timeoutMs: 30000, cwd: allowed },
}), { mode: 0o600 });
writeFileSync(join(home, ".mailroom/workflows.json"), JSON.stringify({
  "review-items": {
    estimate: { minutes: 1, claudeTurns: 18 },
    timeoutMs: 120000,
    steps: [
      { id: "list", run: "list-items" },
      { id: "nothing-to-do", run: "check-answers", when: "!$list.items" },
      { id: "answers", batch: "ask:review-item", items: "$list.items", with: { item: "$item" }, concurrency: 3 },
      { id: "checked", run: "check-answers", stdin: "$answers" },
    ],
  },
}), { mode: 0o600 });
// the laptop ceiling: exactly what this project needs
writeFileSync(join(home, ".mailroom/policy.json"), JSON.stringify({ folders: [allowed], tasks: ["workflow"], commands: ["list-items", "check-answers"], prompts: ["review-item"], workflows: ["review-items"], claudeTools: ["Read"], claudeMaxTurns: 8, batchMaxConcurrency: 3, batchMaxItems: 50 }), { mode: 0o600 });

console.log("starting wrangler dev ...");
const w = spawn("npx", ["wrangler", "dev", "--port", String(PORT), "--inspector-port", String(PORT + 550), "--persist-to", join(tmp, "state")], { cwd: root, stdio: "ignore", detached: true });
procs.push(w);
if (!(await until(async () => { try { return (await fetch(BASE + "/admin/state")).status === 401; } catch { return false; } }, 60000))) { console.log("FAIL wrangler did not start"); process.exit(1); }
let r = await fetch(BASE + "/admin/login", { method: "POST", headers: { "content-type": "application/json", origin: BASE }, body: JSON.stringify({ password: pass }) });
cookie = (r.headers.get("set-cookie") || "").split(";")[0];

console.log("contract and key (what the owner grants this project)");
const base = { folders: [allowed], tasks: ["workflow"], commands: ["list-items", "check-answers"], prompts: ["review-item"], batches: ["ask:review-item"], workflows: ["review-items"], batchMaxItems: 50, batchMaxConcurrency: 3, claudeTools: ["Read"], claudeMaxTurns: 8, dailyLimit: 100, expires: null, approval: [] };
r = await owner("POST", "/admin/contracts", { name: "Pipelines tight", ...base, claudeDailyTurns: 14, claudeDailyMinutes: 60 });
ok(r.status === 201 && r.json.workflows?.[0] === "review-items" && r.json.batches?.[0] === "ask:review-item", `contract with workflows and batch targets saved (${r.status})`);
const tight = (await owner("POST", "/admin/keys", { label: "tight", contract_id: r.json.id })).json;
r = await owner("POST", "/admin/contracts", { name: "Pipelines roomy", ...base, claudeDailyTurns: 200, claudeDailyMinutes: 60 });
const roomy = (await owner("POST", "/admin/keys", { label: "roomy", contract_id: r.json.id })).json;
r = await owner("POST", "/admin/contracts", { name: "No batch", ...base, batches: [] });
ok(r.status === 201, `a contract with workflows and no batch task needs no batch targets (${r.status})`);
r = await owner("POST", "/admin/contracts", { name: "Bad", ...base, tasks: ["batch"], batches: [], workflows: [] });
ok(r.status === 422 && r.json.errors?.batches, "a contract allowing batch must name its targets");
const cred = (await owner("POST", "/admin/laptop/rotate")).json.credential;
await new Promise(res => spawn("node", [join(root, "daemon/cli.ts"), "login", "--url", BASE, "--credential", cred], { env: { ...process.env, HOME: home }, stdio: "ignore" }).on("exit", res));
const daemon = spawn("node", [join(root, "daemon/cli.ts"), "run"], { env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` }, stdio: "ignore", detached: true });
procs.push(daemon);
ok(await until(async () => (await owner("GET", "/admin/laptop")).json.connected), "daemon connected");

const mrTight = createClient({ url: BASE, key: tight.key });
const mrRoomy = createClient({ url: BASE, key: roomy.key });
const api = async (key, path) => (await fetch(BASE + path, { headers: { authorization: `Bearer ${key}` } })).json();

console.log("estimate (declared on the laptop, visible to the client)");
{
  const wf = (await api(tight.key, "/api/workflows"))[0];
  ok(wf.name === "review-items" && wf.on_laptop && wf.steps === 4 && wf.estimate?.claudeTurns === 18, `GET /api/workflows shows the estimate: ${JSON.stringify(wf.estimate)}`);
  ok(wf.fits_budget === false && /only 14 are left/.test(wf.warning || ""), `and warns the tight key it does not fit: ${wf.warning}`);
  const wr = (await api(roomy.key, "/api/workflows"))[0];
  ok(wr.fits_budget === true, "the roomy key's budget covers it");
  const lp = await owner("GET", "/admin/laptop");
  ok(lp.json.workflows?.[0]?.estimate?.minutes === 1, "the admin laptop view lists the workflow with its estimate");
}

console.log("workflow: list (script) -> batch of Claude questions, three at a time -> check (script), streamed, inside the budget");
{
  fileLogReset();
  const t0 = Date.now();
  const sub = await mrTight.submit("workflow", { name: "review-items", inputs: {} });
  ok(sub.state === "queued" || sub.state === "running", `accepted: ${sub.state}`);
  const partials = [];
  const progress = [];
  const job = await mrTight.wait(sub.id, { intervalMs: 300, timeoutMs: 90000, onProgress: p => progress.push(p.text), onPartial: (v, n) => partials.push({ v, n, at: Date.now() - t0 }) });
  ok(job.state === "done", `the workflow is one parcel and ends done: ${job.state} ${job.reason || ""}`);
  const steps = job.result?.steps ?? [];
  ok(steps.map(s => `${s.id}:${s.status}`).join(",") === "list:done,nothing-to-do:skipped,answers:done,checked:done", `step list: ${steps.map(s => `${s.id}:${s.status}`).join(",")}`);
  // the tight key has 14 turns for 9 items that want 2 each: some items are cut short or never start; the final script still sees all 9 and the job ends done
  const out = job.result?.output;
  ok(out?.seen === 9 && out.answered + out.failed === 9 && out.failed >= 1, `check script output: ${JSON.stringify(out)}`);
  const keyInfo = (await owner("GET", `/admin/keys/${tight.id}`)).json;
  ok(keyInfo.claude_usage?.turns >= 12 && keyInfo.claude_usage.turns <= 14, `it stayed in the budget: ${keyInfo.claude_usage?.turns} of 14 turns used`);
  ok(maxOverlap() === 3, `at most three Claude questions at a time (saw ${maxOverlap()})`);
  ok(startsCount() === out?.answered, `the items past the budget never started Claude (${startsCount()} started, ${out?.failed} did not)`);
  const script_ = partials.filter(p => p.v.step === "list" && p.v.partial);
  const items = partials.filter(p => p.v.step === "answers" && p.v.index !== undefined);
  ok(script_.length >= 5 && items.length === 9, `partials: ${script_.length} from the listing script, ${items.length} batch items`);
  ok(partials[0].at < 3500 && partials[0].v.partial?.listed >= 1, `the first partial arrived ${partials[0].at} ms after submit, while the job was still running`);
  const firstItem = items[0].at, lastItem = items[items.length - 1].at;
  ok(firstItem + 1500 < Date.now() - t0 && lastItem - firstItem >= 1500, `item results streamed over ${lastItem - firstItem} ms, not all at the end`);
  ok(partials.every((p, i) => p.n === (partials[0].n + i)), "partials come in order, numbered");
  ok(progress.some(t => /answers: [1-9] of 9/.test(t)) && progress.some(t => /step 1 of 4: list/.test(t)), `progress shows steps and n of N: ${progress.filter(t => /of 9/.test(t)).slice(0, 3).join(" | ")}`);
  const back = await api(tight.key, `/api/jobs/${sub.id}`);
  ok(back.partials >= 20, `the parcel carries its partials count (${back.partials})`);
  const list = await api(tight.key, `/api/jobs/${sub.id}/partials?after=${back.partials - 2}`);
  ok(list.partials.length === 2 && list.count === back.partials, "GET /api/jobs/:id/partials?after=n returns only the newer ones");
  const failedItems = job.result?.output ? true : false;
  void failedItems;
  const detail = (await owner("GET", `/admin/jobs/${sub.id}`)).json;
  ok(detail.partials === back.partials, "the admin view (and so mailroom_get_parcel) shows the partials count");
}

console.log("every step obeys the contract and the laptop policy");
{
  let s = await mrRoomy.submit("workflow", { name: "no-such-workflow" });
  ok(s.state === "refused" && /not in the contract/.test(s.reason || ""), `a workflow the contract does not list is refused: ${s.reason}`);
  s = await mrRoomy.submit("workflow", { name: "review-items", extra: 1 });
  ok(s.state === "refused" && /takes only name and inputs/.test(s.reason || ""), `workflow args are strict: ${s.reason}`);
  // a contract whose command list lacks one of the workflow's steps: refused by the daemon before any step runs
  r = await owner("POST", "/admin/contracts", { name: "Missing step", ...base, commands: ["list-items"], claudeDailyTurns: 200 });
  const k2 = (await owner("POST", "/admin/keys", { label: "missing", contract_id: r.json.id })).json;
  const j2 = await createClient({ url: BASE, key: k2.key }).submit("workflow", { name: "review-items" });
  const done2 = await createClient({ url: BASE, key: k2.key }).wait(j2.id, { intervalMs: 300, timeoutMs: 20000 });
  ok(done2.state === "refused" && /step “nothing-to-do”: command “check-answers” is not in the contract/.test(done2.reason || ""), `a forbidden step refuses the whole workflow: ${done2.reason}`);
  // the laptop policy: take check-answers away from the ceiling
  const pol = JSON.parse(readFileSync(join(home, ".mailroom/policy.json"), "utf8"));
  writeFileSync(join(home, ".mailroom/policy.json"), JSON.stringify({ ...pol, commands: ["list-items"] }), { mode: 0o600 });
  const j3 = await mrRoomy.submit("workflow", { name: "review-items" });
  const done3 = await mrRoomy.wait(j3.id, { intervalMs: 300, timeoutMs: 20000 });
  ok(done3.state === "refused" && /laptop policy/.test(done3.reason || ""), `the laptop policy refuses it too: ${done3.reason}`);
  writeFileSync(join(home, ".mailroom/policy.json"), JSON.stringify(pol), { mode: 0o600 });
  // batch is its own task: refused when the contract does not allow it
  s = await mrRoomy.submit("batch", { prompt: "review-item", items: [{ item: "x" }] });
  ok(s.state === "refused" && /not in the contract/.test(s.reason || ""), `batch is refused where the contract lacks the task: ${s.reason}`);
}

console.log("cancel: stops the running step and starts nothing more");
{
  fileLogReset();
  const sub = await mrRoomy.submit("workflow", { name: "review-items" });
  const seen = [];
  const waiting = mrRoomy.wait(sub.id, { intervalMs: 250, timeoutMs: 60000, onPartial: v => seen.push(v) }).catch(e => e);
  ok(await until(async () => seen.some(v => v.step === "answers" && v.index !== undefined), 30000), "the batch is under way (a first item result streamed)");
  const t0 = Date.now();
  r = await fetch(`${BASE}/api/jobs/${sub.id}/cancel`, { method: "POST", headers: { authorization: `Bearer ${roomy.key}`, "content-type": "application/json" }, body: "{}" });
  ok(r.status === 200, "cancel accepted");
  const j = await waiting;
  ok(j.state === "cancelled", `the parcel is cancelled: ${j.state}`);
  const startsAtCancel = startsCount();
  await sleep(3500);
  ok(startsCount() === startsAtCancel && startsAtCancel < N, `no new Claude question started after cancel (${startsAtCancel} of ${N} started, still ${startsCount()})`);
  ok(Date.now() - t0 < 6000, "and it stopped promptly");
  ok(await until(async () => ((await owner("GET", `/admin/keys/${roomy.id}`)).json.claude_usage?.turns ?? 0) >= 2, 10000), "what the cancelled run used still counts toward the key's budget");
}

console.log(failed ? `\nPIPELINE E2E FAILED (${failed})` : "\nPIPELINE E2E PASSED");
process.exit(failed ? 1 : 0);

function fileLogReset() { rmSync(claudeLog, { force: true }); }
function lines() { return existsSync(claudeLog) ? readFileSync(claudeLog, "utf8").split("\n").filter(Boolean).map(l => l.split(" ")) : []; }
function startsCount() { return lines().filter(l => l[0] === "start").length; }
function maxOverlap() {
  let cur = 0, max = 0;
  for (const l of lines().sort((a, b) => Number(a[2]) - Number(b[2]) || (a[0] === "end" ? -1 : 1))) { cur += l[0] === "start" ? 1 : -1; max = Math.max(max, cur); }
  return max;
}
