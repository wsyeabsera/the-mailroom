import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { CRED, FakeHub, cli, contract, isResult, job, tmpHome } from "./daemon-helpers.ts";

const FIXTURE = path.resolve(import.meta.dirname, "fixtures/fake-stdio-mcp.mjs");
let hub: FakeHub, home: string, d: ReturnType<typeof cli>;

before(async () => {
  hub = new FakeHub();
  await hub.start();
  home = tmpHome();
  fs.mkdirSync(path.join(home, ".mailroom"));
  fs.writeFileSync(path.join(home, ".mailroom/local-mcp.json"), JSON.stringify({ fake: { command: process.execPath, args: [FIXTURE], callTimeoutSeconds: 5 } }), { mode: 0o600 });
  await cli(home, ["login", "--url", hub.url, "--credential", CRED]).exited;
  d = cli(home, ["run"]);
  await hub.waitFor(m => m.type === "hello");
});
after(async () => { d.kill(); await hub.stop(); });

let n = 0;
const C = (over: Record<string, unknown> = {}) => contract(home, { tasks: ["echo", "mcp_list", "mcp_call"], localMcp: [{ server: "fake", tools: [{ name: "echo", approval: false }, { name: "write_thing" }] }], ...over });
async function run(task: string, args: Record<string, unknown>, c: unknown = C()) {
  const id = `lm_${++n}`;
  hub.push(job(id, task, args, c));
  return hub.waitFor(isResult(id));
}

test("mcp_list over the real daemon: only the contract's tools", async () => {
  const r = await run("mcp_list", {});
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.result.servers[0].tools.map((t: any) => [t.name, t.readOnly, t.requiresApproval]), [["echo", true, false], ["write_thing", false, true]]);
});

test("mcp_call over the real daemon runs a listed tool", async () => {
  const r = await run("mcp_call", { server: "fake", tool: "echo", args: { hello: "world" } });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.result.content[0].text, '{"hello":"world"}');
});

test("the daemon refuses what the contract does not list, and anything that names a command", async () => {
  for (const args of [{ server: "fake", tool: "hidden" }, { server: "other", tool: "echo" }, { server: "fake", tool: "echo", command: "/bin/sh" }, { server: "fake", tool: "Echo" }]) {
    const r = await run("mcp_call", args);
    assert.equal(r.type, "refuse", JSON.stringify(args));
  }
  assert.equal((await run("mcp_call", { server: "fake", tool: "echo" }, C({ tasks: ["echo"] }))).type, "refuse");
});

test("a contract server this laptop has not defined is refused with the fix", async () => {
  const r = await run("mcp_call", { server: "ghost", tool: "t" }, C({ localMcp: [{ server: "ghost", tools: [{ name: "t" }] }] }));
  assert.equal(r.type, "refuse");
  assert.match(r.reason, /not defined on this laptop.*local-mcp\.json/);
});
