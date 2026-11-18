import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { purgeLogs, readLog, writeLog, logsDir } from "../daemon/logs.ts";
import { CRED, FakeHub, cli, contract, isResult, job, tmpHome } from "./daemon-helpers.ts";

let hub: FakeHub, home: string, d: ReturnType<typeof cli>;
const SECRET = "tangerine-secret-words";

before(async () => {
  hub = new FakeHub();
  await hub.start();
  home = tmpHome();
  fs.mkdirSync(path.join(home, "allowed"));
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "fake-claude.js"), `
console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: {} }] } }));
console.log(JSON.stringify({ type: "result", result: "${SECRET} not json at all", session_id: "s-" + process.pid, num_turns: 1 }));
`);
  fs.writeFileSync(path.join(bin, "claude"), `#!/bin/sh\nexec node "${bin}/fake-claude.js" "$@"\n`, { mode: 0o755 });
  fs.mkdirSync(path.join(home, ".mailroom"));
  fs.writeFileSync(path.join(home, ".mailroom/prompts.json"), JSON.stringify({ shaped: { template: "Do it", tools: ["Read"], cwd: "~/allowed", schema: { type: "object" } } }), { mode: 0o600 });
  await cli(home, ["login", "--url", hub.url, "--credential", CRED]).exited;
  d = cli(home, ["run"], { PATH: `${bin}:${process.env.PATH}` });
  await hub.waitFor(m => m.type === "hello");
});
after(async () => { d.kill(); await hub.stop(); });

const C = () => contract(home, { tasks: ["echo", "ask", "claude"], prompts: ["shaped"] });

test("a failed ask job leaves a 0600 log with the reply and turns, and none of it reaches the Hub", async () => {
  hub.push(job("lg_1", "ask", { prompt: "shaped" }, C()));
  const r = await hub.waitFor(isResult("lg_1"));
  assert.equal(r.ok, false);
  assert.ok(!JSON.stringify(hub.messages).includes(SECRET), "the reply text must not be sent to the Hub");
  const f = path.join(home, ".mailroom/logs/lg_1.txt");
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(f)).mode & 0o777, 0o700);
  const txt = fs.readFileSync(f, "utf8");
  assert.match(txt, new RegExp(SECRET));
  assert.match(txt, /turn 1: using Read/);
});

test("`mailroom logs <job id>` prints it; an unknown id says so", async () => {
  const ok = cli(home, ["logs", "lg_1"]);
  assert.equal(await ok.exited, 0);
  assert.match(ok.out(), new RegExp(SECRET));
  const none = cli(home, ["logs", "nope_1"]);
  assert.equal(await none.exited, 1);
  assert.match(none.out(), /no log for nope_1/);
  const bad = cli(home, ["logs", "../x"]);
  assert.equal(await bad.exited, 1);
});

test("policy logs: false turns the log off", async () => {
  fs.writeFileSync(path.join(home, ".mailroom/policy.json"), JSON.stringify({ folders: ["~/allowed"], tasks: ["echo", "ask", "claude"], prompts: ["shaped"], logs: false }), { mode: 0o600 });
  try {
    hub.push(job("lg_2", "ask", { prompt: "shaped" }, C()));
    await hub.waitFor(isResult("lg_2"));
    assert.ok(!fs.existsSync(path.join(home, ".mailroom/logs/lg_2.txt")));
  } finally {
    fs.rmSync(path.join(home, ".mailroom/policy.json"));
  }
});

test("`mailroom policy logs off|on` edits the switch", async () => {
  assert.equal(await cli(home, ["policy", "logs", "off"]).exited, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, ".mailroom/policy.json"), "utf8")).logs, false);
  const show = cli(home, ["policy", "show"]);
  await show.exited;
  assert.match(show.out(), /debug logs: off/);
  fs.rmSync(path.join(home, ".mailroom/policy.json"));
});

test("files older than 7 days are deleted, newer ones stay; a bad job id writes nothing", () => {
  const h = tmpHome();
  writeLog("old_1", { label: "ask", turns: [], reply: "x" }, h);
  writeLog("new_1", { label: "ask", turns: [], reply: "y" }, h);
  writeLog("../evil", { label: "ask", turns: [], reply: "z" }, h);
  assert.deepEqual(fs.readdirSync(logsDir(h)).sort(), ["new_1.txt", "old_1.txt"]);
  const old = new Date(Date.now() - 8 * 24 * 3600_000);
  fs.utimesSync(path.join(logsDir(h), "old_1.txt"), old, old);
  assert.equal(purgeLogs(h), 1);
  assert.deepEqual(fs.readdirSync(logsDir(h)), ["new_1.txt"]);
  assert.ok("text" in readLog("new_1", h));
});

test("the daemon deletes old logs when it starts", async () => {
  const h = tmpHome();
  fs.mkdirSync(path.join(h, ".mailroom/logs"), { recursive: true });
  const f = path.join(h, ".mailroom/logs/ancient_1.txt");
  fs.writeFileSync(f, "old");
  const old = new Date(Date.now() - 9 * 24 * 3600_000);
  fs.utimesSync(f, old, old);
  await cli(h, ["login", "--url", hub.url, "--credential", CRED]).exited;
  const dd = cli(h, ["run"]);
  try {
    await new Promise(r => setTimeout(r, 1000));
    assert.ok(!fs.existsSync(f));
  } finally {
    dd.kill();
  }
});
