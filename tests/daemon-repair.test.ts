import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { CRED, FakeHub, cli, contract, isResult, job, tmpHome } from "./daemon-helpers.ts";

let hub: FakeHub, home: string, d: ReturnType<typeof cli>;

before(async () => {
  hub = new FakeHub();
  await hub.start();
  home = tmpHome();
  fs.mkdirSync(path.join(home, "allowed"));
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin);
  // fake claude: a first run answers badly (by MODE); a resumed run (--resume) answers by RMODE (GOOD or BAD). Every run logs its argv to calls.log.
  fs.writeFileSync(path.join(bin, "fake-claude.js"), `
const fs = require("node:fs");
const a = process.argv.slice(2), prompt = a[a.length - 1];
fs.appendFileSync(${JSON.stringify(path.join(home, "calls.log"))}, JSON.stringify(a) + "\\n");
const resumed = a.includes("--resume");
let text;
if (resumed) text = prompt.includes("Your last reply") && process.env.RMODE !== "BAD" ? '{"ok":true}' : "still prose";
else text = prompt.includes('MODE "TRUNC"') ? '{"ok":tr' : "Sorry, I forgot the format.";
if (prompt.includes('MODE "GOOD"')) text = 'Here: {"ok":true}';
console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hm" }] } }));
console.log(JSON.stringify({ type: "result", result: text, session_id: "sess-" + (resumed ? "r" : "a") + process.pid, num_turns: resumed ? 2 : 3 }));
`);
  fs.writeFileSync(path.join(bin, "claude"), `#!/bin/sh\nexec node "${bin}/fake-claude.js" "$@"\n`, { mode: 0o755 });
  fs.mkdirSync(path.join(home, ".mailroom"));
  const schema = { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } };
  const base = { template: "Do it MODE {mode}", vars: { mode: { type: "string" } }, tools: ["Read"], maxTurns: 6, timeoutMs: 5000, cwd: "~/allowed", schema };
  fs.writeFileSync(path.join(home, ".mailroom/prompts.json"), JSON.stringify({ repairing: { ...base, repair: 1 }, plain: base, "bad-repair": { ...base, repair: 7 } }), { mode: 0o600 });
  await cli(home, ["login", "--url", hub.url, "--credential", CRED]).exited;
  d = cli(home, ["run"], { PATH: `${bin}:${process.env.PATH}` });
  await hub.waitFor(m => m.type === "hello");
});
after(async () => { d.kill(); await hub.stop(); });

let n = 0;
const C = () => contract(home, { tasks: ["echo", "ask"], prompts: ["repairing", "plain", "bad-repair"] });
async function ask(args: Record<string, unknown>, budget?: { turns: number; ms: number }) {
  const id = `rp_${++n}`;
  hub.push({ ...job(id, "ask", args, C()), ...(budget ? { budget } : {}) });
  return hub.waitFor(isResult(id));
}
const calls = () => (fs.existsSync(path.join(home, "calls.log")) ? fs.readFileSync(path.join(home, "calls.log"), "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)) : []);

test("repair: 1 resumes the same session once with a fixed message and returns the fixed answer; both runs count in usage", async () => {
  const before = calls().length;
  const r = await ask({ prompt: "repairing", vars: { mode: "X" } });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.result, { output: { ok: true } });
  const c = calls().slice(before);
  assert.equal(c.length, 2);
  assert.ok(!c[0].includes("--resume"));
  assert.ok(c[1].includes("--resume"));
  assert.match(c[1][c[1].length - 1], /^Your last reply was not one JSON value/);
  assert.equal(c[1][c[1].indexOf("--max-turns") + 1], "2");
  assert.equal(r.usage.turns, 5, "3 turns for the first run plus 2 for the repair");
});

test("repair fails: the job fails with the schema error, after exactly one repair", async () => {
  d.kill();
  const bin = path.join(home, "bin");
  d = cli(home, ["run"], { PATH: `${bin}:${process.env.PATH}`, RMODE: "BAD" });
  await hub.waitFor(m => m.type === "hello" && hub.messages.filter(x => x.type === "hello").length > 1 ? true : false).catch(() => {});
  await new Promise(r => setTimeout(r, 800));
  const before = calls().length;
  const r = await ask({ prompt: "repairing", vars: { mode: "X" } });
  assert.equal(r.ok, false);
  assert.match(r.error, /not valid JSON/);
  assert.equal(calls().length - before, 2);
});

test("a prompt without repair is not retried", async () => {
  const before = calls().length;
  const r = await ask({ prompt: "plain", vars: { mode: "X" } });
  assert.equal(r.ok, false);
  assert.equal(calls().length - before, 1);
});

test("a reply with a sentence before valid JSON passes without a repair", async () => {
  const before = calls().length;
  const r = await ask({ prompt: "repairing", vars: { mode: "GOOD" } });
  assert.deepEqual(r.result, { output: { ok: true } });
  assert.equal(calls().length - before, 1);
});

test("no repair when the budget is used up by the first run", async () => {
  const before = calls().length;
  const r = await ask({ prompt: "repairing", vars: { mode: "X" } }, { turns: 3, ms: 600000 });
  assert.equal(r.ok, false);
  assert.equal(calls().length - before, 1);
});

test("a bad repair value in the registry refuses the prompt", async () => {
  const r = await ask({ prompt: "bad-repair", vars: { mode: "X" } });
  assert.equal(r.type, "refuse");
  assert.match(r.reason, /bad repair/);
});
