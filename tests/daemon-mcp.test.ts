import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { askOptions } from "../daemon/tasks.ts";
import { loadMcpServers, mcpConfigArgs, mcpServerOf } from "../daemon/mcp.ts";
import { doctor } from "../daemon/doctor.ts";
import { validateContract, toolNameOk } from "../shared/contract.ts";
import { loadPrompt } from "../daemon/prompts.ts";
import { CRED, FakeHub, cli, contract, isResult, job, tmpHome } from "./daemon-helpers.ts";

const TOOL = "mcp__browser__page_text";
let hub: FakeHub, home: string, d: ReturnType<typeof cli>;

before(async () => {
  hub = new FakeHub();
  await hub.start();
  home = tmpHome();
  fs.mkdirSync(path.join(home, "allowed"));
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin);
  // A fake MCP server over stdio (newline-delimited JSON-RPC): one tool, page_text, which answers with a marker.
  fs.writeFileSync(path.join(home, "fake-mcp.js"), `
require("node:readline").createInterface({ input: process.stdin }).on("line", l => {
  const m = JSON.parse(l);
  const send = r => console.log(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: r }));
  if (m.method === "initialize") send({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } });
  else if (m.method === "tools/call") send({ content: [{ type: "text", text: "PAGE:" + m.params.arguments.url }] });
  else if (m.id !== undefined) send({});
});
`);
  // A fake claude that does what claude does with --mcp-config: starts the servers it names and calls the allowed MCP tool.
  fs.writeFileSync(path.join(bin, "fake-claude.js"), `
const { spawn } = require("node:child_process");
const a = process.argv.slice(2);
require("node:fs").appendFileSync(${JSON.stringify(path.join(home, "calls.log"))}, JSON.stringify(a) + "\\n");
const val = f => a[a.indexOf(f) + 1];
const done = text => { console.log(JSON.stringify({ type: "result", result: text, num_turns: 1 })); process.exit(0); };
const cfgText = a.includes("--mcp-config") ? val("--mcp-config") : null;
if (!cfgText) done("NO-MCP strict=" + a.includes("--strict-mcp-config"));
const cfg = JSON.parse(cfgText).mcpServers;
const names = Object.keys(cfg);
const tool = a[a.indexOf("--allowedTools") + 1 + a.slice(a.indexOf("--allowedTools") + 1).findIndex(x => x.startsWith("mcp__"))];
const [, server, name] = /^mcp__([^_]+)__(.+)$/.exec(tool) || [];
const s = cfg[server];
const child = spawn(s.command, s.args, { stdio: ["pipe", "pipe", "inherit"] });
const rl = require("node:readline").createInterface({ input: child.stdout });
const pending = new Map();
rl.on("line", l => { const m = JSON.parse(l); pending.get(m.id)?.(m.result); });
const rpc = (method, params) => new Promise(r => { const id = pending.size + 1; pending.set(id, r); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\\n"); });
(async () => {
  await rpc("initialize", {});
  const r = await rpc("tools/call", { name, arguments: { url: "http://example.com/live" } });
  child.kill();
  done("servers=" + names.join(",") + " tools=" + a.slice(a.indexOf("--allowedTools") + 1, a.indexOf("--max-turns")).join(",") + " " + r.content[0].text + " strict=" + a.includes("--strict-mcp-config"));
})();
`);
  fs.writeFileSync(path.join(bin, "claude"), `#!/bin/sh\nexec node "${bin}/fake-claude.js" "$@"\n`, { mode: 0o755 });
  fs.mkdirSync(path.join(home, ".mailroom"));
  const reg = {
    browse: { template: "Read the page", tools: ["Read", TOOL], maxTurns: 3, timeoutMs: 8000, cwd: "~/allowed" },
    "undeclared-user": { template: "x", tools: ["mcp__ghost__go"], maxTurns: 3, timeoutMs: 8000, cwd: "~/allowed" },
    "no-mcp": { template: "x", tools: ["Read"], maxTurns: 3, timeoutMs: 8000, cwd: "~/allowed" },
  };
  fs.writeFileSync(path.join(home, ".mailroom/prompts.json"), JSON.stringify(reg), { mode: 0o600 });
  fs.writeFileSync(path.join(home, ".mailroom/mcp.json"), JSON.stringify({ browser: { command: process.execPath, args: [path.join(home, "fake-mcp.js")] }, other: { command: "/bin/false" } }), { mode: 0o600 });
  await cli(home, ["login", "--url", hub.url, "--credential", CRED]).exited;
  d = cli(home, ["run"], { PATH: `${bin}:${process.env.PATH}` });
  await hub.waitFor(m => m.type === "hello");
});
after(async () => { d.kill(); await hub.stop(); });

let n = 0;
const C = (over: Record<string, unknown> = {}) => contract(home, { tasks: ["echo", "ask", "claude"], prompts: ["browse", "undeclared-user", "no-mcp"], claudeTools: ["Read", TOOL, "mcp__ghost__go"], claudeMaxTurns: 5, ...over });
async function ask(prompt: string, c: unknown = C()) {
  const id = `mc_${++n}`;
  hub.push(job(id, "ask", { prompt }, c));
  return hub.waitFor(isResult(id));
}
const calls = () => fs.readFileSync(path.join(home, "calls.log"), "utf8").trim().split("\n").map(l => JSON.parse(l));

test("tool names: exactly mcp__<server>__<tool>, no wildcards", () => {
  assert.equal(toolNameOk(TOOL), true);
  assert.equal(toolNameOk("Read"), true);
  assert.equal(toolNameOk("mcp__browser__*"), false);
  assert.equal(toolNameOk("mcp__browser"), false);
  assert.equal(toolNameOk("mcp__browser__"), false);
  assert.equal(toolNameOk("mcp__*"), false);
  assert.equal(mcpServerOf(TOOL), "browser");
  assert.equal(mcpServerOf("Read"), null);
  const v = validateContract({ name: "x", folders: ["~/a"], tasks: ["ask"], dailyLimit: 1, prompts: ["p"], claudeTools: ["Read", "mcp__browser__*"] });
  assert.equal(v.ok, false);
  assert.match((v as any).errors.claudeTools, /one tool at a time/);
  assert.equal(validateContract({ name: "x", folders: ["~/a"], tasks: ["ask"], dailyLimit: 1, prompts: ["p"], claudeTools: ["Read", TOOL] }).ok, true);
});

test("a prompt may list one MCP tool; a wildcard in a prompt's tools is not loaded", () => {
  const h = tmpHome();
  fs.mkdirSync(path.join(h, ".mailroom"));
  fs.writeFileSync(path.join(h, ".mailroom/prompts.json"), JSON.stringify({ ok: { template: "x", tools: [TOOL], cwd: "~/a" }, wild: { template: "x", tools: ["mcp__browser__*"], cwd: "~/a" } }), { mode: 0o600 });
  assert.ok("prompt" in loadPrompt("ok", h));
  assert.match((loadPrompt("wild", h) as any).error, /has bad tools/);
});

test("mcp.json: only command and args; no environment; mode 0600", () => {
  const h = tmpHome();
  fs.mkdirSync(path.join(h, ".mailroom"));
  const f = path.join(h, ".mailroom/mcp.json");
  fs.writeFileSync(f, JSON.stringify({ good: { command: "x", args: ["a"] }, secret: { command: "x", env: { TOKEN: "s3cret" } }, "bad name!": { command: "x" } }), { mode: 0o600 });
  const r = loadMcpServers(h);
  assert.deepEqual(Object.keys(r.servers), ["good"]);
  assert.ok(r.problems.some(p => /“secret” has env: only command and args are allowed/.test(p)));
  assert.ok(r.problems.some(p => /bad name/.test(p)));
  fs.chmodSync(f, 0o644);
  const loose = loadMcpServers(h);
  assert.deepEqual(Object.keys(loose.servers), []);
  assert.match(loose.problems[0], /must be mode 0600/);
  const none = loadMcpServers(tmpHome());
  assert.deepEqual([Object.keys(none.servers), none.problems, none.present], [[], [], false]);
});

test("mcpConfigArgs starts only the servers the allowed tools name, with --strict-mcp-config right after the list", () => {
  const r = mcpConfigArgs(["Read", TOOL], home) as { argv: string[] };
  assert.equal(r.argv[0], "--mcp-config");
  assert.deepEqual(Object.keys(JSON.parse(r.argv[1]).mcpServers), ["browser"]);
  assert.equal(r.argv[2], "--strict-mcp-config");
  assert.deepEqual(mcpConfigArgs(["Read"], home), { argv: [] });
  assert.match((mcpConfigArgs(["mcp__nope__x"], home) as any).error, /MCP server “nope” is not declared/);
});

test("askOptions never silently drops an MCP tool the contract does not allow", () => {
  const p = { tools: ["Read", TOOL], maxTurns: 3, scratch: false } as any;
  assert.match(String(((): unknown => { try { askOptions(p, { tools: ["Read"], maxTurns: 5 }, home); } catch (e) { return (e as Error).message; } })()), /needs the MCP tool mcp__browser__page_text, which the contract does not allow/);
  assert.ok(askOptions(p, { tools: ["Read", TOOL], maxTurns: 5 }, home).argv.includes("--strict-mcp-config"));
});

test("a prompt uses exactly one declared MCP tool: the fake server runs and answers, nothing else is started", async () => {
  const r = await ask("browse");
  assert.equal(r.ok, true, r.error);
  assert.equal(r.result.output.trim(), `servers=browser tools=Read,${TOOL} PAGE:http://example.com/live strict=true`);
});

test("a prompt with no MCP tool gets no MCP config at all", async () => {
  const r = await ask("no-mcp");
  assert.equal(r.ok, true, r.error);
  assert.ok(!calls().at(-1).includes("--mcp-config"));
});

test("undeclared server: refused, naming mcp.json", async () => {
  const r = await ask("undeclared-user");
  assert.equal(r.type, "refuse");
  assert.match(r.reason, /MCP server “ghost” is not declared on this laptop.*mcp\.json/);
});

test("a contract without the tool refuses the job (it is not silently dropped)", async () => {
  const r = await ask("browse", C({ claudeTools: ["Read"] }));
  assert.equal(r.type, "refuse");
  assert.match(r.reason, /needs the MCP tool mcp__browser__page_text, which the contract does not allow/);
});

test("a policy without the tool refuses the job and names the fix", async () => {
  fs.writeFileSync(path.join(home, ".mailroom/policy.json"), JSON.stringify({ folders: ["~/allowed"], tasks: ["echo", "ask"], prompts: ["browse"], claudeTools: ["Read"] }), { mode: 0o600 });
  try {
    const r = await ask("browse", C({ prompts: ["browse"], tasks: ["echo", "ask"], claudeTools: ["Read", TOOL] }));
    assert.equal(r.type, "refuse");
    assert.match(r.reason, /mailroom policy allow-claude-tool 'mcp__browser__page_text'/);
    fs.writeFileSync(path.join(home, ".mailroom/policy.json"), JSON.stringify({ folders: ["~/allowed"], tasks: ["echo", "ask"], prompts: ["browse"], claudeTools: ["Read", TOOL] }), { mode: 0o600 });
    const ok = await ask("browse", C({ prompts: ["browse"], tasks: ["echo", "ask"], claudeTools: ["Read", TOOL] }));
    assert.equal(ok.ok, true, ok.error ?? ok.reason);
  } finally { fs.rmSync(path.join(home, ".mailroom/policy.json")); }
});

test("a claude job may list the MCP tool in allowedTools when the contract allows it; an undeclared one is refused", async () => {
  const id = `mc_${++n}`;
  hub.push(job(id, "claude", { prompt: "go", cwd: "~/allowed", allowedTools: [TOOL] }, C()));
  const r = await hub.waitFor(isResult(id));
  assert.equal(r.ok, true, r.error ?? r.reason);
  assert.match(r.result.output, /PAGE:http/);
  const id2 = `mc_${++n}`;
  hub.push(job(id2, "claude", { prompt: "go", cwd: "~/allowed", allowedTools: ["mcp__ghost__go"] }, C()));
  assert.match((await hub.waitFor(isResult(id2))).reason, /MCP server “ghost” is not declared/);
});

test("doctor checks mcp.json: an undeclared server a prompt needs, a server command that is not found, an env entry", () => {
  const h = tmpHome();
  fs.mkdirSync(path.join(h, "a"));
  fs.mkdirSync(path.join(h, ".mailroom"));
  fs.writeFileSync(path.join(h, ".mailroom/prompts.json"), JSON.stringify({ b: { template: "x", tools: [TOOL], cwd: "~/a" } }), { mode: 0o600 });
  let e = doctor({ home: h, pathEnv: "/bin:/usr/bin" }).filter(f => f.level === "error").map(f => f.message);
  assert.ok(e.some(m => /prompt “b”: tool mcp__browser__page_text needs the MCP server “browser”, which is not declared in .*mcp\.json/.test(m)));
  fs.writeFileSync(path.join(h, ".mailroom/mcp.json"), JSON.stringify({ browser: { command: "no-such-browser-server" }, leaky: { command: "/bin/sh", env: { K: "v" } } }), { mode: 0o600 });
  e = doctor({ home: h, pathEnv: "/bin:/usr/bin" }).filter(f => f.level === "error").map(f => f.message);
  assert.ok(e.some(m => /MCP server “browser”: command “no-such-browser-server” is not found/.test(m)));
  assert.ok(e.some(m => /“leaky” has env/.test(m)));
});
