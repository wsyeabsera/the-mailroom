import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { MAX_PARTIALS, MAX_PARTIAL_BYTES, cleanPartial, oldestKept, parsePartialLine } from "../shared/partials.ts";
import { tmpHome } from "./daemon-helpers.ts";

test("parsePartialLine: JSON after the prefix, anything else is not a partial", () => {
  assert.deepEqual(parsePartialLine('MAILROOM_PARTIAL {"a":1}'), { value: { a: 1 } });
  assert.deepEqual(parsePartialLine("MAILROOM_PARTIAL [1,2]\r"), { value: [1, 2] });
  assert.deepEqual(parsePartialLine('MAILROOM_PARTIAL "x"'), { value: "x" });
  assert.equal(parsePartialLine("MAILROOM_PARTIAL {not json"), undefined);
  assert.equal(parsePartialLine("MAILROOM_PARTIAL "), undefined);
  assert.equal(parsePartialLine('noise MAILROOM_PARTIAL {"a":1}'), undefined);
  assert.equal(parsePartialLine("MAILROOM_PROGRESS 5 x"), undefined);
});

test("partials are size capped, and the count cap keeps the newest", () => {
  assert.equal(cleanPartial({ a: 1 }), '{"a":1}');
  assert.equal(cleanPartial("x".repeat(MAX_PARTIAL_BYTES)), null); // with the quotes it is over the cap
  assert.equal(cleanPartial(undefined), null);
  assert.equal(oldestKept(MAX_PARTIALS), 1);
  assert.equal(oldestKept(MAX_PARTIALS + 1), 2); // the oldest is dropped
  assert.equal(oldestKept(5), 5 - MAX_PARTIALS + 1); // nothing to drop yet (<= 0)
});

test("run: MAILROOM_PARTIAL lines arrive in order, split chunks and bad lines included", async () => {
  const home = tmpHome();
  process.env.HOME = home;
  const script = path.join(home, "scan.sh");
  fs.writeFileSync(script, `#!/bin/sh\necho 'MAILROOM_PARTIAL {"i":1}' >&2\necho 'MAILROOM_PARTIAL nope' >&2\nprintf 'MAILROOM_PARTIAL {"i"' >&2\nsleep 0.1\nprintf ':2}\\n' >&2\necho 'MAILROOM_PARTIAL {"i":3}' >&2\necho done\n`, { mode: 0o755 });
  fs.mkdirSync(path.join(home, ".mailroom"), { recursive: true });
  fs.writeFileSync(path.join(home, ".mailroom/commands.json"), JSON.stringify({ scan: { script, cwd: home, args: {} } }), { mode: 0o600 });
  const { runTask } = await import("../daemon/tasks.ts");
  const seen: unknown[] = [];
  const job = { id: "j", task: "run", args: { command: "scan", args: {} }, contract: {} as any };
  const r = (await runTask(job, home, new AbortController().signal, () => {}, () => {}, v => seen.push(v))) as { output: string };
  assert.equal(r.output.trim(), "done");
  assert.deepEqual(seen, [{ i: 1 }, { i: 2 }, { i: 3 }]);
});
