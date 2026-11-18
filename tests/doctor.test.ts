import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { doctor, explain, which, fetchFromHub } from "../daemon/doctor.ts";
import http from "node:http";
import { CRED, FakeHub, cli, isResult, job, tmpHome } from "./daemon-helpers.ts";

const write = (home: string, name: string, data: unknown, mode = 0o600) => {
  fs.mkdirSync(path.join(home, ".mailroom"), { recursive: true });
  fs.writeFileSync(path.join(home, ".mailroom", name), typeof data === "string" ? data : JSON.stringify(data), { mode });
  fs.chmodSync(path.join(home, ".mailroom", name), mode);
};
const script = (home: string, name: string, body: string, mode = 0o755) => {
  const p = path.join(home, name);
  fs.writeFileSync(p, body, { mode });
  fs.chmodSync(p, mode);
  return p;
};
const c = (over: Record<string, unknown> = {}) => ({ name: "proj", folders: ["~/work"], tasks: ["echo", "run", "ask"], dailyLimit: 10, expires: null, approval: [], commands: ["lister"], prompts: ["finder"], claudeTools: ["Read"], claudeMaxTurns: 5, ...over }) as any;
const msgs = (f: ReturnType<typeof doctor>, level?: string) => f.filter(x => !level || x.level === level).map(x => x.message + (x.fix ? ` || ${x.fix}` : ""));

function fixture() {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, "work"));
  fs.mkdirSync(path.join(home, "bin"));
  return home;
}

test("a healthy setup has no errors", () => {
  const home = fixture();
  const ok = script(home, "list.sh", "#!/bin/sh\necho '[]'\n");
  write(home, "commands.json", { lister: { script: ok, cwd: "~/work", args: {} } });
  write(home, "prompts.json", { finder: { template: "find", tools: ["Read"], cwd: "~/work" } });
  write(home, "policy.json", { folders: ["~/work"], tasks: ["echo", "run", "ask"], commands: ["lister"], prompts: ["finder"], claudeTools: ["Read"] });
  const f = doctor({ home, contracts: [c()], pathEnv: "/bin:/usr/bin" });
  assert.deepEqual(msgs(f, "error"), []);
  assert.deepEqual(msgs(f, "warn").filter(m => !/claude/.test(m)), []);
});

test("file modes, script paths, executable bit, interpreter under the service PATH", () => {
  const home = fixture();
  write(home, "commands.json", {
    gone: { script: path.join(home, "nope.sh"), cwd: "~/work" },
    plain: { script: script(home, "plain.sh", "#!/bin/sh\n", 0o644), cwd: "~/work" },
    noshebang: { script: script(home, "ns.sh", "echo hi\n"), cwd: "~/work" },
    nodey: { script: script(home, "nodey.mjs", "#!/usr/bin/env definitely-not-installed\n"), cwd: "~/work" },
    nocwd: { script: script(home, "ok.sh", "#!/bin/sh\n"), cwd: "~/missing" },
  }, 0o644);
  const f = msgs(doctor({ home, pathEnv: "/bin:/usr/bin" }), "error");
  const has = (re: RegExp) => assert.ok(f.some(m => re.test(m)), `expected ${re} in:\n${f.join("\n")}`);
  has(/commands\.json is readable by others.*\|\| chmod 600 .*commands\.json/);
  // the registry is refused wholesale while its mode is wrong; fix the mode and look at the entries
  fs.chmodSync(path.join(home, ".mailroom/commands.json"), 0o600);
  const g = msgs(doctor({ home, pathEnv: "/bin:/usr/bin" }), "error");
  const ghas = (re: RegExp) => assert.ok(g.some(m => re.test(m)), `expected ${re} in:\n${g.join("\n")}`);
  ghas(/“gone”: script .*nope\.sh does not exist/);
  ghas(/“plain”: .*plain\.sh is not executable.*\|\| chmod \+x/);
  ghas(/“noshebang”: .*has no #! line/);
  ghas(/“nodey”: its interpreter “definitely-not-installed” is not found on the background service's PATH/);
  ghas(/“nocwd”: cwd ~\/missing is not a folder/);
});

test("a node script is found only if node is on the service PATH", () => {
  const home = fixture();
  const s = script(home, "n.mjs", "#!/usr/bin/env node\n");
  write(home, "commands.json", { n: { script: s, cwd: "~/work" } });
  assert.ok(msgs(doctor({ home, pathEnv: "/usr/bin" }), "error").some(m => /interpreter “node”/.test(m)));
  fs.writeFileSync(path.join(home, "bin/node"), "#!/bin/sh\n", { mode: 0o755 });
  assert.deepEqual(msgs(doctor({ home, pathEnv: `${home}/bin` }), "error"), []);
  assert.equal(which("node", `${home}/bin`), path.join(home, "bin/node"));
});

test("a contract outside the policy names the fix; registry entries no contract uses are warned; contract names not registered are errors", () => {
  const home = fixture();
  const ok = script(home, "list.sh", "#!/bin/sh\n");
  write(home, "commands.json", { lister: { script: ok, cwd: "~/work" }, unused: { script: ok, cwd: "~/work" } });
  write(home, "prompts.json", { finder: { template: "x", tools: ["Read", "WebFetch"], cwd: "~/work" }, stale: { template: "x", tools: ["Read"], cwd: "~/work" } });
  write(home, "policy.json", { folders: ["~/other"], tasks: ["echo"], commands: [], prompts: [], claudeTools: ["Read"] });
  const f = doctor({ home, contracts: [c({ commands: ["lister", "ghost"], prompts: ["finder", "ghost-prompt"] })], pathEnv: "/bin:/usr/bin" });
  const e = msgs(f, "error"), w = msgs(f, "warn");
  assert.ok(e.some(m => /contract “proj”: contract folder ~\/work is outside the laptop policy folders.*\|\| mailroom policy allow-folder ~\/work/.test(m)), e.join("\n"));
  assert.ok(e.some(m => /command “ghost”, which is not in .*commands\.json/.test(m)));
  assert.ok(e.some(m => /prompt “ghost-prompt”, which is not in .*prompts\.json/.test(m)));
  assert.ok(e.some(m => /command “lister”: cwd .*work is outside the policy folders.*allow-folder/.test(m)));
  assert.ok(w.some(m => /command “unused” is not used by any contract/.test(m)));
  assert.ok(w.some(m => /prompt “stale” is not used by any contract/.test(m)));
  assert.ok(w.some(m => /command “lister” is not in the policy.*mailroom policy allow-command lister/.test(m)));
  assert.ok(w.some(m => /prompt “finder”: tools WebFetch are outside the policy and will be dropped.*allow-claude-tool 'WebFetch'/.test(m)));
});

test("a prompt none of whose tools the policy or the contract allows can never run", () => {
  const home = fixture();
  write(home, "prompts.json", { finder: { template: "x", tools: ["WebSearch"], cwd: "~/work" } });
  write(home, "policy.json", { folders: ["~/work"], tasks: ["ask"], prompts: ["finder"], claudeTools: ["Read"] });
  const e = msgs(doctor({ home, contracts: [c({ commands: [] })], pathEnv: "/bin:/usr/bin" }), "error");
  assert.ok(e.some(m => /prompt “finder”: none of its tools \(WebSearch\) are within the policy.*allow-claude-tool 'WebSearch'/.test(m)));
  assert.ok(e.some(m => /none of prompt “finder”'s tools \(WebSearch\) are in the contract's claudeTools/.test(m)));
});

test("an unreadable policy and broken registries are reported", () => {
  const home = fixture();
  write(home, "policy.json", "{nope");
  write(home, "commands.json", "[1]");
  write(home, "prompts.json", { bad: { template: "uses {x}", cwd: "~/work" } });
  const e = msgs(doctor({ home, pathEnv: "/bin" }), "error");
  assert.ok(e.some(m => /laptop policy unusable.*not valid JSON/.test(m)));
  assert.ok(e.some(m => /commands\.json must be an object/.test(m)));
  assert.ok(e.some(m => /uses \{x\} but does not declare it/.test(m)));
});

test("explain says which stage refuses, and says the same as a real job", async () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, "work"));
  const ok = script(home, "list.sh", "#!/bin/sh\necho '[]'\n");
  write(home, "commands.json", { lister: { script: ok, cwd: "~/work" } });
  write(home, "policy.json", { folders: ["~/other"], tasks: ["echo", "run"], commands: [] });
  const contract = c({ tasks: ["echo", "run"], commands: ["lister"], prompts: [] });
  const jobArgs = { task: "run", args: { command: "lister", args: {} } };
  const ex = explain(contract, jobArgs, home);
  assert.equal(ex.refused, true);
  assert.equal(ex.stage, "daemon");
  assert.match(ex.lines[0], /gateway.*allowed/);
  assert.match(ex.lines[1], /daemon \(this laptop\): REFUSED: contract folder ~\/work is outside the laptop policy folders/);

  const hub = new FakeHub();
  await hub.start();
  await cli(home, ["login", "--url", hub.url, "--credential", CRED]).exited;
  const d = cli(home, ["run"]);
  try {
    await hub.waitFor(m => m.type === "hello");
    hub.push(job("ex_1", "run", jobArgs.args, contract));
    const real = await hub.waitFor(isResult("ex_1"));
    assert.equal(real.type, "refuse");
    assert.equal(real.reason, ex.reason);
  } finally { d.kill(); await hub.stop(); }

  const g = explain(contract, { task: "write_file", args: { path: "~/work/a", content: "x" } }, home);
  assert.equal(g.stage, "gateway");
  assert.match(g.lines[0], /gateway.*REFUSED: task “write_file” is not in the contract/);
  assert.equal(explain({ ...contract, approval: ["echo"] }, { task: "echo", args: { text: "x" } }, home).lines[0].includes("waits for the owner's approval"), true);
});

test("`mailroom doctor` exits 1 with the fix line on a broken setup, 0 on a good one", async () => {
  const home = fixture();
  write(home, "commands.json", { x: { script: path.join(home, "nope.sh"), cwd: "~/work" } });
  const p = cli(home, ["doctor"]);
  assert.equal(await p.exited, 1);
  assert.match(p.out(), /ERROR command “x”: script .*nope\.sh does not exist/);
  assert.match(p.out(), /fix: fix the path in/);
  const clean = tmpHome();
  const q = cli(clean, ["doctor"]);
  assert.equal(await q.exited, 0);
  assert.match(q.out(), /No problems found/);
});

test("`mailroom explain` with --contract and with a Hub token", async () => {
  const home = fixture();
  const contract = c({ tasks: ["echo"], commands: [], prompts: [] });
  const file = path.join(home, "contract.json");
  fs.writeFileSync(file, JSON.stringify(contract));
  const p = cli(home, ["explain", "any", JSON.stringify({ task: "echo", args: { text: "hi" } }), "--contract", file]);
  assert.equal(await p.exited, 0);
  assert.match(p.out(), /gateway.*allowed[\s\S]*daemon \(this laptop\): allowed/);
  const q = cli(home, ["explain", "any", JSON.stringify({ task: "run", args: {} }), "--contract", file]);
  assert.equal(await q.exited, 1);
  assert.match(q.out(), /gateway.*REFUSED/);

  // the Hub's MCP channel: keys and contracts
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", d => (body += d));
    req.on("end", () => {
      const m = JSON.parse(body);
      const out = m.params.name === "mailroom_list_keys" ? [{ id: "k1", label: "tv app", contract: { id: "c_1", name: "proj" }, revoked_at: null }] : [{ id: "c_1", ...contract }];
      res.writeHead(req.headers.authorization === "Bearer mra_good" ? 200 : 401, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: JSON.stringify(out) }], isError: false } }));
    });
  });
  await new Promise<void>(r => srv.listen(0, "127.0.0.1", () => r()));
  const url = `http://127.0.0.1:${(srv.address() as any).port}`;
  try {
    const got = await fetchFromHub(url, "mra_good");
    assert.equal(got.keys[0].label, "tv app");
    assert.equal(got.contracts[0].name, "proj");
    await assert.rejects(fetchFromHub(url, "mra_bad"), /did not accept that admin token/);
    await cli(home, ["login", "--url", url, "--credential", CRED]).exited;
    const r = cli(home, ["explain", "tv app", JSON.stringify({ task: "echo", args: { text: "x" } }), "--token", "mra_good"]);
    assert.equal(await r.exited, 0, r.out());
    const none = cli(home, ["explain", "ghost key", JSON.stringify({ task: "echo", args: {} }), "--token", "mra_good"]);
    assert.equal(await none.exited, 1);
    assert.match(none.out(), /No live key is labelled/);
  } finally { srv.close(); }
});
