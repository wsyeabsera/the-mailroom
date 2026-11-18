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
  fs.mkdirSync(path.join(home, ".mailroom"));
  const script = path.join(home, "emit.sh");
  fs.writeFileSync(script, `#!/bin/sh\nif [ "$2" = "bad" ]; then echo "secret words, not json"; else echo '{"items":[1,2,3]}'; fi\n`, { mode: 0o755 });
  const spec = (output?: string) => ({ script, cwd: "~/allowed", timeoutMs: 5000, args: { mode: { type: "string" } }, ...(output ? { output } : {}) });
  fs.writeFileSync(path.join(home, ".mailroom/commands.json"), JSON.stringify({ lister: spec("json"), plain: spec(), weird: spec("xml") }), { mode: 0o600 });
  await cli(home, ["login", "--url", hub.url, "--credential", CRED]).exited;
  d = cli(home, ["run"]);
  await hub.waitFor(m => m.type === "hello");
});
after(async () => { d.kill(); await hub.stop(); });

const C = () => contract(home, { tasks: ["echo", "run"], commands: ["lister", "plain", "weird"] });
async function run(id: string, args: Record<string, unknown>) {
  hub.push(job(id, "run", args, C()));
  return hub.waitFor(isResult(id));
}

test("output: json returns the parsed object as result.output", async () => {
  const m = await run("j1", { command: "lister", args: { mode: "ok" } });
  assert.equal(m.type, "result");
  assert.deepEqual(m.result.output, { items: [1, 2, 3] });
});

test("without output: json the same stdout stays text", async () => {
  const m = await run("j2", { command: "plain", args: { mode: "ok" } });
  assert.equal(typeof m.result.output, "string");
});

test("invalid JSON fails with the byte count, not the text", async () => {
  const m = await run("j3", { command: "lister", args: { mode: "bad" } });
  assert.equal(m.ok, false);
  assert.match(m.error, /printed 23 bytes that are not valid JSON/);
  assert.doesNotMatch(m.error, /secret/);
});

test("an unknown output kind refuses the job", async () => {
  const m = await run("j4", { command: "weird", args: {} });
  assert.equal(m.type, "refuse");
  assert.match(m.reason, /bad output/);
});
