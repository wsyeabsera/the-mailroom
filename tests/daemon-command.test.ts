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
  const allowed = path.join(home, "allowed");
  const outside = path.join(home, "outside");
  fs.mkdirSync(allowed);
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(allowed, "link"));
  const script = path.join(home, "show.sh");
  fs.writeFileSync(script, `#!/bin/sh\nfor a in "$@"; do echo "ARG:$a"; done\necho "CWD:$(pwd -P)"\n[ "$2" = "fail" ] && { echo boom >&2; exit 3; }\nexit 0\n`, { mode: 0o755 });
  fs.mkdirSync(path.join(home, ".mailroom"), { recursive: true });
  const spec = (cwd: string) => ({ script, cwd, timeoutMs: 5000, args: { msg: { type: "string", required: true, maxLength: 50 }, n: { type: "number" }, mode: { type: "enum", values: ["a", "b"] }, loud: { type: "boolean" } } });
  fs.writeFileSync(path.join(home, ".mailroom/commands.json"), JSON.stringify({ show: { ...spec("~/allowed"), rerunSafe: true }, escape: spec("~/allowed/link") }), { mode: 0o600 });
  await cli(home, ["login", "--url", hub.url, "--credential", CRED]).exited;
  d = cli(home, ["run"]);
  await hub.waitFor(m => m.type === "hello");
});

after(async () => {
  d.kill();
  await hub.stop();
});

const C = (commands = ["show", "escape", "ghost"]) => contract(home, { tasks: ["echo", "run"], commands });
async function run(id: string, args: Record<string, unknown>, c: unknown = C()) {
  hub.push(job(id, "run", args, c));
  return hub.waitFor(isResult(id));
}

test("hello lists the re-run-safe commands in a separate rerunSafe field (default is not safe)", () => {
  const h = hub.messages.find(m => m.type === "hello");
  assert.deepEqual(h.rerunSafe, ["show"]);
});

test("run: output and exitCode, args as separate argv entries", async () => {
  const m = await run("r1", { command: "show", args: { msg: "hi there", n: 2, mode: "a", loud: true } });
  assert.equal(m.type, "result");
  assert.deepEqual(m.result.output.trim().split("\n"), ["ARG:--msg", "ARG:hi there", "ARG:--n", "ARG:2", "ARG:--mode", "ARG:a", "ARG:--loud", `CWD:${path.join(home, "allowed")}`]);
  assert.equal(m.result.exitCode, 0);
});

test("run: shell metacharacters stay literal", async () => {
  const evil = "$(touch pwned);`touch pwned2`|echo x>pwned3&&*";
  const m = await run("r2", { command: "show", args: { msg: evil } });
  assert.equal(m.result.output.split("\n")[1], `ARG:${evil}`);
  for (const f of ["pwned", "pwned2", "pwned3"]) assert.ok(!fs.existsSync(path.join(home, "allowed", f)));
});

test("run: unknown command, command not in the contract, bad args are refused", async () => {
  assert.equal((await run("r3", { command: "ghost", args: {} })).type, "refuse");
  assert.equal((await run("r4", { command: "show", args: { msg: "x" } }, C([]))).type, "refuse");
  for (const [i, args] of [{}, { msg: 5 }, { msg: "x".repeat(51) }, { msg: "x", n: "2" }, { msg: "x", mode: "c" }, { msg: "x", extra: 1 }, { msg: "x", loud: "yes" }].entries()) {
    const m = await run("rb" + i, { command: "show", args });
    assert.equal(m.type, "refuse", JSON.stringify(args));
  }
});

test("run: a registered cwd that escapes through a symlink is refused", async () => {
  const m = await run("r5", { command: "escape", args: { msg: "x" } });
  assert.equal(m.type, "refuse");
  assert.match(m.reason, /outside the contract folders/);
});

test("run: a non-zero exit fails with the stderr tail", async () => {
  const m = await run("r6", { command: "show", args: { msg: "fail" } });
  assert.equal(m.type === "result" && m.ok, false);
  assert.match(JSON.stringify(m), /exited with 3: boom/);
});

test("run: a registry that is not mode 0600 is refused", async () => {
  const f = path.join(home, ".mailroom/commands.json");
  fs.chmodSync(f, 0o644);
  assert.equal((await run("r7", { command: "show", args: { msg: "x" } })).type, "refuse");
  fs.chmodSync(f, 0o600);
});
