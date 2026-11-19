import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { McpSupervisor, capResult, childEnv, MAX_MCP_OUTPUT_BYTES } from "../daemon/mcp-supervisor.ts";
import { loadLocalMcp } from "../daemon/local-mcp.ts";
import { runMcpTask } from "../daemon/mcp-tasks.ts";
import { recheck, type JobMsg } from "../daemon/tasks.ts";
import type { Contract } from "../shared/contract.ts";
import { tmpHome } from "./daemon-helpers.ts";

const FIXTURE = path.resolve(import.meta.dirname, "fixtures/fake-stdio-mcp.mjs");
const sups: McpSupervisor[] = [];
afterEach(() => { for (const s of sups.splice(0)) s.shutdown(); });

/** A laptop home with a local-mcp.json defining "fake" (and whatever else `extra` adds). */
function laptop(def: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  const home = tmpHome();
  const starts = path.join(home, "starts.log");
  fs.mkdirSync(path.join(home, ".mailroom"));
  fs.writeFileSync(path.join(home, ".mailroom/local-mcp.json"), JSON.stringify({ fake: { command: process.execPath, args: [FIXTURE, starts], ...def }, ...extra }), { mode: 0o600 });
  const startCount = () => (fs.existsSync(starts) ? fs.readFileSync(starts, "utf8").trim().split("\n").length : 0);
  const sup = (o: ConstructorParameters<typeof McpSupervisor>[0] = {}) => { const s = new McpSupervisor({ home, ...o }); sups.push(s); return s; };
  return { home, startCount, sup };
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (f: () => boolean, ms = 3000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error("timed out waiting"); await new Promise(r => setTimeout(r, 20)); } };
const textOf = (r: { content: unknown[] }) => (r.content[0] as { text: string }).text;

test("local-mcp.json: strict shape, mode 0600, env must be strings", () => {
  const h = tmpHome();
  fs.mkdirSync(path.join(h, ".mailroom"));
  const f = path.join(h, ".mailroom/local-mcp.json");
  fs.writeFileSync(f, JSON.stringify({
    good: { command: "x", args: ["a"], env: { TOKEN: "s" }, cwd: "/tmp", idleSeconds: 5, callTimeoutSeconds: 2 },
    "bad name!": { command: "x" }, noCmd: {}, extra: { command: "x", shell: true }, badEnv: { command: "x", env: { A: 1 } }, badEnvName: { command: "x", env: { "A=B": "1" } },
    relCwd: { command: "x", cwd: "rel" }, badIdle: { command: "x", idleSeconds: 0 }, badTimeout: { command: "x", callTimeoutSeconds: 9999 }, badArgs: { command: "x", args: [1] },
  }), { mode: 0o600 });
  const r = loadLocalMcp(h);
  assert.deepEqual(Object.keys(r.servers), ["good"]);
  assert.deepEqual([r.servers.good.idleMs, r.servers.good.callTimeoutMs, r.servers.good.env], [5000, 2000, { TOKEN: "s" }]);
  assert.equal(r.problems.length, 9);
  fs.chmodSync(f, 0o644);
  assert.match(loadLocalMcp(h).problems[0], /must be mode 0600/);
  const none = loadLocalMcp(tmpHome());
  assert.deepEqual([Object.keys(none.servers), none.problems, none.present], [[], [], false]);
  fs.chmodSync(f, 0o600);
  fs.writeFileSync(f, JSON.stringify({ d: { command: "x" } }), { mode: 0o600 });
  assert.deepEqual([loadLocalMcp(h).servers.d.idleMs, loadLocalMcp(h).servers.d.callTimeoutMs], [120_000, 30_000]); // the defaults, in ms
  assert.equal(Object.hasOwn(loadLocalMcp(h).servers, "__proto__"), false);
});

test("lists all pages of tools with readOnly from annotations, starts lazily, and reuses one process", async () => {
  const l = laptop();
  const sup = l.sup();
  assert.equal(l.startCount(), 0);
  const tools = await sup.listTools("fake");
  assert.equal(l.startCount(), 1);
  assert.deepEqual(tools.map(t => t.name), ["echo", "write_thing", "slow", "crash", "big", "peek_env", "pid", "hidden", "fail"]);
  assert.equal(tools.find(t => t.name === "echo")!.readOnly, true);
  assert.equal(tools.find(t => t.name === "write_thing")!.readOnly, false);
  const r = await sup.callTool("fake", "echo", { a: 1 });
  assert.equal(textOf(r), '{"a":1}');
  assert.equal(r.isError, false);
  assert.equal((await sup.callTool("fake", "fail", {})).isError, true);
  assert.equal(l.startCount(), 1);
});

test("an undefined server never starts anything", async () => {
  const l = laptop();
  const sup = l.sup();
  await assert.rejects(sup.listTools("ghost"), /not defined on this laptop/);
  await assert.rejects(sup.callTool("__proto__", "x", {}), /not defined on this laptop/);
  assert.equal(l.startCount(), 0);
});

test("the child gets only the base env plus what the local config lists: no daemon secrets", async () => {
  process.env.MAILROOM_TEST_SECRET = "hunter2";
  try {
    const l = laptop({ env: { LISTED: "yes" } });
    const sup = l.sup();
    const env = JSON.parse(textOf(await sup.callTool("fake", "peek_env", {})));
    assert.equal(env.LISTED, "yes");
    assert.equal(env.MAILROOM_TEST_SECRET, undefined);
    assert.ok(Object.keys(env).every(k => ["PATH", "HOME", "LANG", "TMPDIR", "USER", "SHELL", "LISTED"].includes(k) || k.startsWith("__CF") || k.startsWith("LC_")), Object.keys(env).join());
  } finally { delete process.env.MAILROOM_TEST_SECRET; }
  const e = childEnv({ command: "x", args: [], env: { PATH: "/custom" }, cwd: undefined, idleMs: 1, callTimeoutMs: 1 }, { PATH: "/usr/bin", AWS_SECRET: "s", HOME: "/h" });
  assert.deepEqual(e, { PATH: "/custom", HOME: "/h" }); // the config may override a base value; nothing else leaks
});

test("a call that times out stops the server; the next call starts a fresh one", async () => {
  const l = laptop({ callTimeoutSeconds: 1 });
  const sup = l.sup();
  await sup.listTools("fake");
  const pid = sup.pidOf("fake")!;
  const t0 = Date.now();
  await assert.rejects(sup.callTool("fake", "slow", {}), /timed out after 1s/);
  assert.ok(Date.now() - t0 < 4000);
  await until(() => !alive(pid));
  assert.deepEqual(sup.running(), []);
  assert.equal(textOf(await sup.callTool("fake", "echo", { ok: true })), '{"ok":true}');
  assert.equal(l.startCount(), 2);
});

test("a crash rejects the call, backs off, then restarts", async () => {
  const l = laptop();
  const sup = l.sup({ backoffMs: n => 400 * n });
  await sup.listTools("fake");
  await assert.rejects(sup.callTool("fake", "crash", {}), /exited with 3/);
  await assert.rejects(sup.callTool("fake", "echo", {}), /crashed; restarting in \ds/); // inside the backoff window: no new process
  assert.equal(l.startCount(), 1);
  await new Promise(r => setTimeout(r, 450));
  assert.equal(textOf(await sup.callTool("fake", "echo", { back: 1 })), '{"back":1}');
  assert.equal(l.startCount(), 2);
  // backoff grows with repeated crashes and resets after a success
  await assert.rejects(sup.callTool("fake", "crash", {}), /exited with 3/);
  await assert.rejects(sup.callTool("fake", "echo", {}), /restarting/);
});

test("a server that never answers initialize fails the call and is killed", async () => {
  const l = laptop({ command: "/bin/sh", args: ["-c", "sleep 30"] });
  const sup = l.sup({ startTimeoutMs: 300 });
  await assert.rejects(sup.listTools("fake"), /initialize on “fake” timed out/);
  assert.deepEqual(sup.running(), []);
});

test("a server whose command does not exist fails clearly and does not crash the daemon", async () => {
  const l = laptop({ command: "/nonexistent/mcp-server", args: [] });
  await assert.rejects(l.sup().listTools("fake"), /ENOENT|exited/);
});

test("an idle server is killed, and the next call restarts it", async () => {
  const l = laptop({ idleSeconds: 1 });
  const sup = l.sup();
  await sup.listTools("fake");
  const pid = sup.pidOf("fake")!;
  await until(() => !alive(pid), 4000);
  assert.deepEqual(sup.running(), []);
  assert.equal(textOf(await sup.callTool("fake", "echo", { n: 2 })), '{"n":2}');
  assert.equal(l.startCount(), 2);
});

test("editing the local definition replaces the running server", async () => {
  const l = laptop();
  const sup = l.sup();
  await sup.listTools("fake");
  const first = sup.pidOf("fake")!;
  fs.writeFileSync(path.join(l.home, ".mailroom/local-mcp.json"), JSON.stringify({ fake: { command: process.execPath, args: [FIXTURE, path.join(l.home, "starts.log")], env: { CHANGED: "1" } } }), { mode: 0o600 });
  const env = JSON.parse(textOf(await sup.callTool("fake", "peek_env", {})));
  assert.equal(env.CHANGED, "1");
  await until(() => !alive(first));
});

test("output is capped, and cancelling a call ends it without killing the server", async () => {
  const l = laptop();
  const sup = l.sup();
  const r = await sup.callTool("fake", "big", {});
  assert.equal(r.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(r)) <= MAX_MCP_OUTPUT_BYTES + 200);
  const ac = new AbortController();
  const p = sup.callTool("fake", "slow", {}, { signal: ac.signal });
  setTimeout(() => ac.abort(), 100);
  await assert.rejects(p, /cancelled/);
  assert.equal(textOf(await sup.callTool("fake", "echo", { still: "up" })), '{"still":"up"}');
  assert.equal(l.startCount(), 1);
});

test("capResult leaves small results alone and cuts big text and structuredContent", () => {
  const small = { isError: false, content: [{ type: "text", text: "hi" }] };
  assert.equal(capResult(small), small);
  const big = capResult({ isError: false, content: [{ type: "text", text: "é".repeat(1000) }], structuredContent: { a: "x".repeat(5000) } }, 500);
  assert.equal(big.truncated, true);
  assert.equal(big.structuredContent, undefined);
  assert.ok(Buffer.byteLength(JSON.stringify(big)) <= 600);
  assert.doesNotMatch(textOf(big), /�/);
});

test("shutdown kills every child", async () => {
  const l = laptop();
  const sup = l.sup();
  await sup.listTools("fake");
  const pid = sup.pidOf("fake")!;
  sup.shutdown();
  await until(() => !alive(pid));
});

// ---- the tasks: contract filter, approval waiver, recheck ----
const C: Contract = {
  name: "chat", folders: ["~/x"], tasks: ["mcp_list", "mcp_call"], dailyLimit: 10, expires: null, approval: [],
  localMcp: [{ server: "fake", tools: [{ name: "echo", approval: false }, { name: "write_thing" }, { name: "slow", approval: false }, { name: "pid" }, { name: "nonexistent" }, { name: "big", approval: false }] }],
};
const signal = () => new AbortController().signal;
const J = (task: string, args: Record<string, unknown>, c: Contract = C): JobMsg => ({ id: "j", task, args, contract: c });

test("mcp_list returns only tools in the contract, with readOnly and whether approval is needed; never the others", async () => {
  const l = laptop();
  const sup = l.sup();
  const out = (await runMcpTask(J("mcp_list", {}), signal(), sup)) as any;
  assert.deepEqual(out.servers.map((s: any) => s.server), ["fake"]);
  const byName = Object.fromEntries(out.servers[0].tools.map((t: any) => [t.name, t]));
  assert.deepEqual(Object.keys(byName).sort(), ["big", "echo", "pid", "slow", "write_thing"]); // hidden, crash, fail, peek_env are not in the contract; nonexistent is not on the server
  assert.deepEqual([byName.echo.readOnly, byName.echo.requiresApproval], [true, false]);
  assert.deepEqual([byName.write_thing.readOnly, byName.write_thing.requiresApproval], [false, true]);
  assert.equal(typeof byName.echo.description, "string");
  assert.ok(byName.echo.inputSchema);
  assert.equal(JSON.stringify(out).includes("hidden"), false);
  await assert.rejects(runMcpTask(J("mcp_list", { server: "other" }), signal(), sup), /not in the contract/);
});

test("mcp_list reports a server that cannot start as an error entry, not a failed job", async () => {
  const l = laptop({}, { dead: { command: "/nonexistent/x" } });
  const c = { ...C, localMcp: [...C.localMcp!, { server: "dead", tools: [{ name: "t" }] }] };
  const out = (await runMcpTask(J("mcp_list", {}, c), signal(), l.sup())) as any;
  assert.equal(out.servers[0].tools.length, 5);
  assert.ok(out.servers[1].error);
});

test("mcp_call: a listed tool runs; one outside the contract is refused even though the server has it", async () => {
  const l = laptop();
  const sup = l.sup();
  const ok = (await runMcpTask(J("mcp_call", { server: "fake", tool: "echo", args: { q: "hi" } }), signal(), sup)) as any;
  assert.equal(textOf(ok), '{"q":"hi"}');
  assert.deepEqual([ok.server, ok.tool, ok.isError], ["fake", "echo", false]);
  for (const tool of ["hidden", "crash", "peek_env", "ECHO", "echo ", "ｅcho"])
    await assert.rejects(runMcpTask(J("mcp_call", { server: "fake", tool }), signal(), sup), /not in the contract/, tool);
  await assert.rejects(runMcpTask(J("mcp_call", { server: "FAKE", tool: "echo" }), signal(), sup), /not in the contract/);
  await assert.rejects(runMcpTask(J("mcp_call", { server: "fake", tool: "nonexistent" }), signal(), sup), /has no tool/);
});

test("mcp_call: approval:false is honoured only for a readOnly tool", async () => {
  const l = laptop();
  const sup = l.sup();
  const c: Contract = { ...C, localMcp: [{ server: "fake", tools: [{ name: "write_thing", approval: false }, { name: "echo", approval: false }] }] };
  await assert.rejects(runMcpTask(J("mcp_call", { server: "fake", tool: "write_thing" }, c), signal(), sup), /not annotated readOnly/);
  assert.equal(textOf((await runMcpTask(J("mcp_call", { server: "fake", tool: "echo", args: {} }, c), signal(), sup)) as any), "{}");
  // a non-readOnly tool without the waiver runs (the Hub already held it for the owner's approval)
  assert.equal(textOf((await runMcpTask(J("mcp_call", { server: "fake", tool: "write_thing" }), signal(), sup)) as any), "wrote");
});

test("mcp_call: a big result is capped, a slow tool times out per the laptop's setting", async () => {
  const l = laptop({ callTimeoutSeconds: 1 });
  const sup = l.sup();
  const big = (await runMcpTask(J("mcp_call", { server: "fake", tool: "big" }), signal(), sup)) as any;
  assert.equal(big.truncated, true);
  await assert.rejects(runMcpTask(J("mcp_call", { server: "fake", tool: "slow" }), signal(), sup), /timed out after 1s/);
});

test("recheck: runs the contract check again, needs the server defined on this laptop, and honours the laptop policy", () => {
  const l = laptop();
  const policy = (tasks: string[]) => fs.writeFileSync(path.join(l.home, ".mailroom/policy.json"), JSON.stringify({ folders: ["~/x"], tasks }), { mode: 0o600 });
  policy(["mcp_list", "mcp_call"]);
  const r = (task: string, args: Record<string, unknown>, c: Contract = C) => recheck(J(task, args, c), Date.now(), l.home);
  assert.deepEqual(r("mcp_call", { server: "fake", tool: "echo" }), { resolved: null });
  assert.deepEqual(r("mcp_list", {}), { resolved: null });
  assert.match((r("mcp_call", { server: "fake", tool: "hidden" }) as any).reason, /not in the contract/);
  assert.match((r("mcp_call", { server: "fake", tool: "echo", command: "sh" }) as any).reason, /laptop decides/);
  const undefinedHere: Contract = { ...C, localMcp: [{ server: "elsewhere", tools: [{ name: "t" }] }] };
  assert.match((r("mcp_call", { server: "elsewhere", tool: "t" }, undefinedHere) as any).reason, /not defined on this laptop/);
  assert.match((r("mcp_list", {}, undefinedHere) as any).reason, /not defined on this laptop/);
  policy(["mcp_list"]);
  assert.match((r("mcp_call", { server: "fake", tool: "echo" }) as any).reason, /not allowed by the laptop policy/);
});
