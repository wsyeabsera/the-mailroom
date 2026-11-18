import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpHome } from "./daemon-helpers.ts";

// batch and workflow run straight through recheck + runTask, as the daemon does, against registries in a temporary HOME.
let home: string, log: string;
let tasks: typeof import("../daemon/tasks.ts");

const writeJson = (name: string, v: unknown) => fs.writeFileSync(path.join(home, ".mailroom", name), JSON.stringify(v), { mode: 0o600 });
const sh = (name: string, body: string) => { const f = path.join(home, name); fs.writeFileSync(f, `#!/bin/sh\n${body}\n`, { mode: 0o755 }); return f; };

before(async () => {
  home = tmpHome();
  process.env.HOME = home;
  log = path.join(home, "claude.log");
  process.env.FAKE_LOG = log;
  fs.mkdirSync(path.join(home, "allowed"));
  fs.mkdirSync(path.join(home, ".mailroom"));
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin);
  // fake claude: logs start/end, takes 300 ms (5 s when the prompt says SLOW), reports 2 turns, answers with the argv it saw
  fs.writeFileSync(path.join(bin, "fake-claude.js"), `
const fs = require("node:fs");
const a = process.argv.slice(2), prompt = a[a.length - 1];
const log = s => fs.appendFileSync(process.env.FAKE_LOG, s + "\\n");
const q = (/Answer "([^"]*)"/.exec(prompt) || [])[1];
log("start " + q + " " + Date.now());
const turns = a[a.indexOf("--max-turns") + 1];
setTimeout(() => {
  log("end " + q + " " + Date.now());
  console.log(JSON.stringify({ type: "result", result: "ANS " + q + " turns<=" + turns, num_turns: 2, session_id: "s" }));
}, prompt.includes("SLOW") ? 5000 : 300);
`);
  fs.writeFileSync(path.join(bin, "claude"), `#!/bin/sh\nexec node "${bin}/fake-claude.js" "$@"\n`, { mode: 0o755 });
  process.env.PATH = `${bin}:${process.env.PATH}`;
  const list = sh("list.sh", `echo 'MAILROOM_PARTIAL {"found":4}' >&2\necho '{"items":["a","b","c","d"]}'`);
  const none = sh("none.sh", `echo '{"items":[]}'`);
  const check = sh("check.sh", `node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=JSON.parse(s);console.log(JSON.stringify({seen:a.length,ok:a.filter(x=>x.ok).length,first:a[0].value}))})'`);
  const flaky = sh("flaky.sh", `[ "$2" = "bad" ] && { echo nope >&2; exit 1; }\necho "fine $2"`);
  const slow = sh("slow.sh", `sleep 5`);
  const boom = sh("boom.sh", `echo broke >&2; exit 2`);
  writeJson("commands.json", {
    list: { script: list, cwd: "~/allowed", args: {} },
    none: { script: none, cwd: "~/allowed", args: {} },
    check: { script: check, cwd: "~/allowed", args: {} },
    flaky: { script: flaky, cwd: "~/allowed", args: { name: { type: "string", required: true } } },
    slow: { script: slow, cwd: "~/allowed", args: {}, timeoutMs: 20000 },
    boom: { script: boom, cwd: "~/allowed", args: {} },
  });
  writeJson("prompts.json", { answer: { template: "Answer {q}", vars: { q: { type: "string", required: true } }, tools: ["Read"], maxTurns: 8, timeoutMs: 20000, cwd: "~/allowed" } });
  const ask = (target: string, extra: Record<string, unknown> = {}) => ({ id: target, batch: `ask:answer`, items: "$list.items", with: { q: "$item" }, ...extra });
  void ask;
  writeJson("workflows.json", {
    three: { inputs: { topic: { type: "string" } }, estimate: { minutes: 1, claudeTurns: 8 }, steps: [
      { id: "list", run: "list" },
      { id: "answers", batch: "ask:answer", items: "$list.items", with: { q: "$item" }, concurrency: 3 },
      { id: "checked", run: "check", stdin: "$answers" },
    ] },
    skip: { steps: [
      { id: "list", run: "list" },
      { id: "again", run: "none", when: "!$list.items" },
      { id: "last", run: "flaky", args: { name: "end" } },
    ] },
    failing: { steps: [{ id: "one", run: "list" }, { id: "two", run: "boom" }, { id: "three", run: "list" }] },
    slowwf: { timeoutMs: 700, steps: [{ id: "s", run: "slow" }] },
    cancelme: { steps: [{ id: "s", run: "slow" }, { id: "after", run: "list" }] },
    small: { budget: { turns: 2, minutes: 5 }, steps: [{ id: "answers", batch: "ask:answer", items: "$inputs.xx", with: { q: "$item" } }], inputs: { xx: { type: "string" } } },
    forbidden: { steps: [{ id: "list", run: "list" }, { id: "x", run: "check", stdin: "$list" }] },
    unknown: { steps: [{ id: "g", run: "ghost" }] },
    bounded: { budget: { turns: 4, minutes: 5 }, steps: [{ id: "list", run: "list" }, { id: "answers", batch: "ask:answer", items: "$list.items", with: { q: "$item" }, concurrency: 1 }] },
  });
  tasks = await import("../daemon/tasks.ts");
});

const contract = (over: Record<string, unknown> = {}) => ({
  name: "t", folders: ["~/allowed"], tasks: ["batch", "workflow"], dailyLimit: 100, expires: null, approval: [],
  commands: ["list", "none", "check", "flaky", "slow", "boom"], prompts: ["answer"], batches: ["run:flaky", "ask:answer"], batchMaxItems: 50, batchMaxConcurrency: 3,
  workflows: ["three", "skip", "failing", "slowwf", "cancelme", "small", "forbidden", "unknown", "bounded"], claudeTools: ["Read"], claudeMaxTurns: 8, ...over,
});

let n = 0;
async function go(task: string, args: Record<string, unknown>, o: { contract?: unknown; budget?: { turns: number; ms: number }; signal?: AbortSignal; onPartial?: (v: any) => void } = {}) {
  const job = { id: `j${++n}`, task, args, contract: (o.contract ?? contract()) as any, ...(o.budget ? { budget: o.budget } : {}) };
  const v = tasks.recheck(job);
  if ("reason" in v) return { refused: v.reason } as any;
  const partials: any[] = [];
  const progress: string[] = [];
  let usage: any;
  let result: any, error: string | undefined;
  try {
    result = await tasks.runTask(job, v.resolved, o.signal ?? new AbortController().signal, t => progress.push(t), u => { usage = u; }, p => { partials.push(p); o.onPartial?.(p); });
  } catch (e) {
    error = (e as Error).message;
  }
  return { result, error, partials, progress, usage, refused: undefined as string | undefined };
}

const starts = () => fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(l => l.startsWith("start")).length : 0;
const maxOverlap = () => {
  let cur = 0, max = 0;
  for (const l of fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map(l => l.split(" ")).sort((a, b) => Number(a[2]) - Number(b[2]) || (a[0] === "end" ? -1 : 1))) { cur += l[0] === "start" ? 1 : -1; max = Math.max(max, cur); }
  return max;
};

test("batch of asks runs three at a time, reports n of N and a partial per item", async () => {
  fs.rmSync(log, { force: true });
  const items = "abcdefg".split("").map(q => ({ q }));
  const r = await go("batch", { prompt: "answer", items });
  assert.equal(r.error, undefined);
  assert.equal(r.result.total, 7);
  assert.equal(r.result.done, 7);
  assert.deepEqual(r.result.items.map((i: any) => i.index), [0, 1, 2, 3, 4, 5, 6]);
  assert.match(r.result.items[0].value, /^ANS a turns<=/);
  assert.equal(maxOverlap(), 3);
  assert.equal(r.partials.length, 7);
  assert.ok(r.progress.includes("0 of 7") && r.progress.includes("7 of 7"));
  assert.deepEqual(r.usage.turns, 14); // 7 items x 2 turns, for the Hub's daily budget
});

test("batch: one bad item is recorded and the rest still run", async () => {
  const r = await go("batch", { command: "flaky", items: [{ name: "x" }, { name: "bad" }, { name: "y" }, { nope: 1 }] });
  assert.equal(r.result.done, 2);
  assert.equal(r.result.failed, 2);
  assert.match(r.result.items[1].error, /exited with 1: nope/);
  assert.match(r.result.items[3].error, /unknown arg “nope”/); // each item is checked like a single job
  assert.equal(r.result.items[0].value, "fine x");
  assert.equal(r.partials.filter((p: any) => !p.ok).length, 2);
});

test("batch: concurrency is capped by the contract, 6 and the laptop policy", async () => {
  fs.rmSync(log, { force: true });
  const items = "abcdef".split("").map(q => ({ q }));
  await go("batch", { prompt: "answer", items, concurrency: 2 });
  assert.equal(maxOverlap(), 2);
  const refused = await go("batch", { prompt: "answer", items, concurrency: 4 });
  assert.match(refused.refused, /more than the contract allows \(3\)/);
  fs.writeFileSync(path.join(home, ".mailroom/policy.json"), JSON.stringify({ folders: ["~/allowed"], tasks: ["batch", "workflow"], commands: ["list", "none", "check", "flaky", "slow", "boom"], prompts: ["answer"], workflows: ["three"], claudeTools: ["Read"], claudeMaxTurns: 8, batchMaxConcurrency: 2 }), { mode: 0o600 });
  try {
    const over = await go("batch", { prompt: "answer", items }, { contract: contract({ workflows: ["three"] }) });
    assert.match(over.refused, /batchMaxConcurrency 3 is more than the laptop policy allows \(2\)/);
    const ok = await go("batch", { prompt: "answer", items: items.slice(0, 2) }, { contract: contract({ batchMaxConcurrency: 2, workflows: ["three"] }) });
    assert.equal(ok.result.done, 2);
    // a prompt the policy does not list: refused through the item check, not just at the top
    fs.writeFileSync(path.join(home, ".mailroom/policy.json"), JSON.stringify({ folders: ["~/allowed"], tasks: ["batch"], commands: ["flaky"], prompts: [], claudeTools: ["Read"] }), { mode: 0o600 });
    const no = await go("batch", { prompt: "answer", items: items.slice(0, 1) }, { contract: contract({ prompts: [], workflows: [] }) });
    assert.match(no.refused, /not in the contract/);
  } finally {
    fs.rmSync(path.join(home, ".mailroom/policy.json"));
  }
});

test("batch: the budget is shared, items get equal slices, and what is used up stops the rest", async () => {
  fs.rmSync(log, { force: true });
  // 4 turns left, one at a time: each item may use all that is free; the fake claude uses 2 per item, so two items run and three do not
  const r = await go("batch", { prompt: "answer", items: "abcde".split("").map(q => ({ q })), concurrency: 1 }, { budget: { turns: 4, ms: 600_000 } });
  assert.equal(r.result.done, 2);
  assert.equal(r.result.failed, 3);
  assert.match(r.result.items[2].error, /Claude budget is used up/);
  assert.equal(starts(), 2); // the others never started claude
  assert.equal(r.usage.turns, 4);
  // three at a time with 6 turns left: each running item is limited to 6 / 3 = 2 turns
  const s = await go("batch", { prompt: "answer", items: "abc".split("").map(q => ({ q })), concurrency: 3 }, { budget: { turns: 6, ms: 600_000 } });
  assert.ok(s.result.items.every((i: any) => i.value.endsWith("turns<=2")), JSON.stringify(s.result.items));
  // fewer turns than workers: slices of one turn, the rest wait for a share back and then fail when nothing is left
  const t = await go("batch", { prompt: "answer", items: "abc".split("").map(q => ({ q })), concurrency: 3 }, { budget: { turns: 2, ms: 600_000 } });
  assert.equal(t.result.done + t.result.failed, 3);
  assert.ok(t.result.done >= 1 && t.result.failed >= 1);
});

test("batch: cancel stops the running items and starts no more", async () => {
  fs.rmSync(log, { force: true });
  const ctl = new AbortController();
  const items = "abcdefgh".split("").map(q => ({ q: q === "a" ? "SLOW" : "SLOW" + q }));
  setTimeout(() => ctl.abort(), 600);
  const t0 = Date.now();
  const r = await go("batch", { prompt: "answer", items, concurrency: 2 }, { signal: ctl.signal });
  assert.ok(Date.now() - t0 < 4000, "stopped well before the 5 s items finished");
  assert.equal(starts(), 2);
  assert.ok(!r.result || r.result.done === 0);
});

test("workflow: run, batch of ask, run is one result and streams its partials", async () => {
  fs.rmSync(log, { force: true });
  const r = await go("workflow", { name: "three", inputs: { topic: "t" } }, { budget: { turns: 100, ms: 600_000 } });
  assert.equal(r.error, undefined);
  assert.deepEqual(r.result.output, { seen: 4, ok: 4, first: "ANS a turns<=8" }); // 100 turns left / 3 workers is a slice of 33; the prompt's own 8 is lower
  assert.deepEqual(r.result.steps.map((s: any) => [s.id, s.status]), [["list", "done"], ["answers", "done"], ["checked", "done"]]);
  assert.equal(maxOverlap() <= 3, true);
  const kinds = r.partials.map((p: any) => (p.partial ? "script" : p.index !== undefined ? "item" : p.status));
  assert.deepEqual(kinds.filter((k: string) => k === "script" || k === "item").length, 5); // 1 from the list script, 4 batch items
  assert.deepEqual(r.partials.filter((p: any) => p.status).map((p: any) => `${p.step}:${p.status}`), ["list:done", "answers:done", "checked:done"]);
  assert.ok(r.progress.some((p: string) => /step 2 of 3: answers: 4 of 4/.test(p)));
  assert.equal(r.usage.turns, 8);
});

test("workflow: a step skipped by `when`, and its output reads as empty", async () => {
  const r = await go("workflow", { name: "skip" });
  assert.deepEqual(r.result.steps.map((s: any) => [s.id, s.status]), [["list", "done"], ["again", "skipped"], ["last", "done"]]);
  assert.equal(r.result.output, "fine end");
});

test("workflow: a failing step ends the workflow, naming the step", async () => {
  const r = await go("workflow", { name: "failing" });
  assert.match(r.error, /step “two” failed: boom exited with 2: broke \(before it: one done\)/);
  assert.ok(r.partials.some((p: any) => p.step === "two" && p.status === "failed"));
  assert.ok(!r.partials.some((p: any) => p.step === "three"));
});

test("workflow: a step the policy forbids refuses the whole workflow before it starts", async () => {
  fs.writeFileSync(path.join(home, ".mailroom/policy.json"), JSON.stringify({ folders: ["~/allowed"], tasks: ["workflow"], commands: ["list", "none", "flaky", "slow", "boom"], prompts: ["answer"], workflows: ["forbidden", "failing", "three"] }), { mode: 0o600 });
  try {
    const r = await go("workflow", { name: "forbidden" }, { contract: contract({ commands: ["list", "none", "flaky", "slow", "boom"], workflows: ["forbidden"] }) });
    assert.match(r.refused, /step “x”: command “check” is not in the contract/);
    const c2 = contract({ workflows: ["forbidden"] }); // the contract lists check, the policy does not
    const r2 = await go("workflow", { name: "forbidden" }, { contract: c2 });
    assert.match(r2.refused, /command “check” is not allowed by the laptop policy/);
  } finally {
    fs.rmSync(path.join(home, ".mailroom/policy.json"));
  }
});

test("workflow: a step outside the contract, an unregistered target, and an unknown workflow are refused up front", async () => {
  assert.match((await go("workflow", { name: "forbidden" }, { contract: contract({ commands: ["list"] }) })).refused, /step “x”: command “check” is not in the contract/);
  assert.match((await go("workflow", { name: "unknown" }, { contract: contract({ commands: ["ghost"] }) })).refused, /step “g”: command “ghost” is not registered/);
  assert.match((await go("workflow", { name: "nope" })).refused, /not in the contract/);
  assert.match((await go("workflow", { name: "three", inputs: { topic: 5 } })).error, /workflow inputs: variable “topic” must be a string/);
});

test("workflow: its own timeout ends it", async () => {
  const t0 = Date.now();
  const r = await go("workflow", { name: "slowwf" });
  assert.match(r.error, /timed out after 1s/);
  assert.ok(Date.now() - t0 < 4000);
});

test("workflow: cancel stops the current step and never starts the next", async () => {
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 400);
  const t0 = Date.now();
  const r = await go("workflow", { name: "cancelme" }, { signal: ctl.signal });
  assert.match(r.error, /cancelled/);
  assert.ok(Date.now() - t0 < 4000);
  assert.ok(!r.partials.some((p: any) => p.step === "after"));
});

test("workflow: its own budget ceiling holds, on top of what the key has left", async () => {
  fs.rmSync(log, { force: true });
  // the workflow allows 2 turns; the key has plenty; the fake claude uses 2 per item
  const r = await go("workflow", { name: "small", inputs: { xx: "ignored" } }, { budget: { turns: 100, ms: 600_000 } });
  // items must be a list: a string input is not
  assert.match(r.error, /is not a list/);
  const b = await go("workflow", { name: "bounded" }, { budget: { turns: 100, ms: 600_000 } });
  assert.equal(b.result.output.filter((i: any) => i.ok).length, 2); // 4-turn ceiling, 2 turns per item
  assert.equal(b.result.output.filter((i: any) => !i.ok).length, 2);
  assert.equal(b.usage.turns, 4);
  // the key's own budget is the tighter one
  const k = await go("workflow", { name: "bounded" }, { budget: { turns: 2, ms: 600_000 } });
  assert.equal(k.result.output.filter((i: any) => i.ok).length, 1);
});
