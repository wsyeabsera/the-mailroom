import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { CRED, FakeHub, cli, contract, isResult, job, tmpHome } from "./daemon-helpers.ts";

let hub: FakeHub, home: string, d: ReturnType<typeof cli>, bin: string, outside: string, allowed: string;

before(async () => {
  hub = new FakeHub();
  await hub.start();
  home = tmpHome();
  allowed = path.join(home, "allowed");
  outside = path.join(home, "outside");
  fs.mkdirSync(allowed);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
  fs.symlinkSync(outside, path.join(allowed, "link"));
  // fake claude: prints args (one per line) and cwd; "sleep" prompt hangs
  bin = path.join(home, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "claude"), `#!/bin/sh
case "$2" in tree*) rm -f "${home}/grandchild.pid"; (sleep 30 & echo $! > "${home}/grandchild.pid"; wait) & wait;; esac
case "$2" in sleep*) echo $$ > "${home}/claude.pid"; exec sleep 30;; esac
for a in "$@"; do last="$a"; done
case "$last" in jsonout*) echo '{"result":"ok","n":1}'; exit 0;; badjson*) echo 'not json'; exit 0;; esac
for a in "$@"; do echo "ARG:$a"; done
echo "CWD:$(pwd -P)"
`, { mode: 0o755 });
  await cli(home, ["login", "--url", hub.url, "--credential", CRED]).exited;
  d = cli(home, ["run"], { PATH: `${bin}:${process.env.PATH}`, MAILROOM_CLAUDE_TIMEOUT_MS: "1500" });
  await hub.waitFor(m => m.type === "hello");
});

after(async () => {
  d.kill();
  await hub.stop();
});

const C = () => contract(home);
async function run(id: string, task: string, args: Record<string, unknown>, c: unknown = C()) {
  hub.push(job(id, task, args, c));
  return hub.waitFor(isResult(id));
}

test("hello carries version and last_seq; welcome persists last_seq", async () => {
  const h = hub.messages.find(m => m.type === "hello");
  assert.equal(h.version, "0.2.0");
  assert.equal(h.last_seq, 0);
  assert.equal(hub.auth[0], `Bearer ${CRED}`);
  await new Promise(r => setTimeout(r, 200));
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, ".mailroom/state.json"), "utf8")).last_seq, 7);
});

test("answers ping with pong", async () => {
  hub.push({ type: "ping" });
  await hub.waitFor(m => m.type === "pong");
});

test("echo round trip", async () => {
  assert.deepEqual(await run("p_1", "echo", { text: "hi" }), { type: "result", id: "p_1", ok: true, result: { echo: "hi" } });
});

test("write_file then read_file inside the folder, parents created, no temp left", async () => {
  const w = await run("p_2", "write_file", { path: "~/allowed/sub/dir/a.txt", content: "héllo" });
  assert.deepEqual(w.result, { bytes: 6 });
  assert.equal(fs.readFileSync(path.join(allowed, "sub/dir/a.txt"), "utf8"), "héllo");
  assert.deepEqual(fs.readdirSync(path.join(allowed, "sub/dir")), ["a.txt"]);
  const r = await run("p_3", "read_file", { path: "~/allowed/sub/dir/a.txt" });
  assert.deepEqual(r.result, { content: "héllo" });
});

test("size limits", async () => {
  const big = "x".repeat(200 * 1024 + 1);
  assert.equal((await run("p_4", "write_file", { path: "~/allowed/big.txt", content: big })).ok, false);
  fs.writeFileSync(path.join(allowed, "big.txt"), big);
  const ok = await run("p_5", "read_file", { path: "~/allowed/big.txt" }); // reads go up to 2 MB now
  assert.equal(ok.ok, true);
  assert.equal(ok.result.content.length, big.length);
  fs.writeFileSync(path.join(allowed, "huge.txt"), "x".repeat(2 * 1024 * 1024 + 1));
  const r = await run("p_5b", "read_file", { path: "~/allowed/huge.txt" });
  assert.equal(r.ok, false);
  assert.match(r.error, /bigger than 2 MB/);
});

test("refuses outside path, .. escape and symlink escape", async () => {
  for (const [i, p] of [["a", "~/outside/secret.txt"], ["b", "~/allowed/../outside/secret.txt"], ["c", "~/allowed/link/secret.txt"]] as const) {
    const m = await run("p_r" + i, "read_file", { path: p });
    assert.equal(m.type, "refuse", p);
    assert.ok(m.reason);
  }
  const w = await run("p_rd", "write_file", { path: "~/allowed/link/new.txt", content: "x" });
  assert.equal(w.type, "refuse");
  assert.ok(!fs.existsSync(path.join(outside, "new.txt")));
  // new file under a symlinked dir that does not exist yet
  const w2 = await run("p_re", "write_file", { path: "~/allowed/link/deep/er/new.txt", content: "x" });
  assert.equal(w2.type, "refuse");
});

test("refuses a task not in the contract, and an unknown task", async () => {
  assert.equal((await run("p_t1", "read_file", { path: "~/allowed/a" }, contract(home, { tasks: ["echo"] }))).type, "refuse");
  assert.equal((await run("p_t2", "rm_rf", {}, contract(home, { tasks: ["rm_rf"] }))).type, "refuse");
});

test("claude: prompt is a single argv entry (no shell), cwd resolved", async () => {
  const prompt = "; rm -rf x $(touch " + home + "/pwned) `id`";
  const m = await run("p_c1", "claude", { prompt, cwd: "~/allowed" });
  assert.equal(m.ok, true);
  const lines = m.result.output.trim().split("\n");
  assert.deepEqual(lines, ["ARG:-p", "ARG:" + prompt, "CWD:" + allowed]);
  assert.ok(!fs.existsSync(path.join(home, "pwned")));
});

test("claude cwd outside is refused", async () => {
  assert.equal((await run("p_c2", "claude", { prompt: "x", cwd: "~/allowed/link" })).type, "refuse");
});

test("claude timeout kills the child", async () => {
  const t0 = Date.now();
  const m = await run("p_c3", "claude", { prompt: "sleep", cwd: "~/allowed" });
  assert.equal(m.ok, false);
  assert.match(m.error, /^timed out after \d+s$/);
  assert.ok(Date.now() - t0 < 10000);
  const pid = Number(fs.readFileSync(path.join(home, "claude.pid"), "utf8"));
  await new Promise(r => setTimeout(r, 200));
  assert.throws(() => process.kill(pid, 0));
});

test("jobs run in order, one at a time", async () => {
  const start = hub.messages.length;
  for (const i of [1, 2, 3]) hub.push(job("o" + i, "write_file", { path: "~/allowed/o.txt", content: String(i) }, C()));
  await hub.waitFor(isResult("o3"));
  const ids = hub.messages.slice(start).filter(m => m.type === "result").map(m => m.id);
  assert.deepEqual(ids, ["o1", "o2", "o3"]);
  assert.equal(fs.readFileSync(path.join(allowed, "o.txt"), "utf8"), "3");
});

test("cancel of a running job kills it and sends nothing", async () => {
  const before = hub.messages.length;
  hub.push(job("k1", "claude", { prompt: "sleep", cwd: "~/allowed" }, C()));
  await new Promise(r => setTimeout(r, 500));
  hub.push({ type: "cancel", id: "k1" });
  await new Promise(r => setTimeout(r, 400));
  // daemon is free again
  const m = await run("k2", "echo", { text: "after" });
  assert.equal(m.ok, true);
  assert.ok(!hub.messages.slice(before).some(x => x.id === "k1"));
});

test("claude options become argv entries before -p", async () => {
  const m = await run("p_o1", "claude", { prompt: "hello", cwd: "~/allowed", allowedTools: ["Read", "Bash(git log:*)"], maxTurns: 3, model: "claude-opus-4[1m]" });
  assert.equal(m.ok, true);
  const o = m.result.output as string;
  assert.match(o, /ARG:--allowedTools\nARG:Read\nARG:Bash\(git log:\*\)\nARG:--max-turns\nARG:3\nARG:--model\nARG:claude-opus-4\[1m\]\nARG:-p\nARG:hello\n/);
});

test("claude json option returns parsed JSON", async () => {
  const m = await run("p_o2", "claude", { prompt: "jsonout", cwd: "~/allowed", json: true });
  assert.deepEqual(m.result, { output: { result: "ok", n: 1 } });
  const bad = await run("p_o3", "claude", { prompt: "badjson", cwd: "~/allowed", json: true });
  assert.equal(bad.ok, false);
});

test("claude rejects invalid options", async () => {
  const bads: Record<string, unknown>[] = [
    { allowedTools: "Read" }, { allowedTools: [] }, { allowedTools: ["a;b"] }, { allowedTools: Array(21).fill("Read") },
    { maxTurns: 0 }, { maxTurns: 51 }, { maxTurns: 1.5 }, { maxTurns: "3" },
    { model: "a b" }, { model: "x".repeat(61) }, { json: "yes" },
  ];
  for (const [i, b] of bads.entries()) {
    const m = await run(`p_ob${i}`, "claude", { prompt: "x", cwd: "~/allowed", ...b });
    assert.equal(m.ok, false, JSON.stringify(b));
  }
});

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const grandchild = async () => {
  for (let i = 0; i < 40; i++) {
    try { const n = Number(fs.readFileSync(path.join(home, "grandchild.pid"), "utf8")); if (n) return n; } catch { /* not yet */ }
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error("grandchild never started");
};

test("cancel kills the whole process tree, grandchildren included", async () => {
  hub.push(job("t1", "claude", { prompt: "tree", cwd: "~/allowed" }, C()));
  const gc = await grandchild();
  assert.ok(alive(gc));
  hub.push({ type: "cancel", id: "t1" });
  await new Promise(r => setTimeout(r, 400));
  assert.equal(alive(gc), false);
  assert.equal((await run("t2", "echo", { text: "free" })).ok, true);
});

test("timeout kills the whole tree and reports 'timed out after Ns'", async () => {
  const m = await run("t3", "claude", { prompt: "tree", cwd: "~/allowed" });
  assert.equal(m.ok, false);
  assert.equal(m.error, "timed out after 2s"); // MAILROOM_CLAUDE_TIMEOUT_MS=1500 rounds to 2s
  const gc = await grandchild();
  await new Promise(r => setTimeout(r, 200));
  assert.equal(alive(gc), false);
});
