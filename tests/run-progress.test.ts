import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpHome } from "./daemon-helpers.ts";

test("run: MAILROOM_PROGRESS lines on stderr are reported, other stderr is not", async () => {
  const home = tmpHome();
  process.env.HOME = home; // the registry is read from os.homedir()
  const script = path.join(home, "scan.sh");
  fs.writeFileSync(script, `#!/bin/sh\necho "MAILROOM_PROGRESS 10 starting" >&2\necho noise >&2\nprintf 'MAILROOM_PROGRESS 5' >&2\nprintf '0 half\\n' >&2\necho done\n`, { mode: 0o755 });
  fs.mkdirSync(path.join(home, ".mailroom"), { recursive: true });
  fs.writeFileSync(path.join(home, ".mailroom/commands.json"), JSON.stringify({ scan: { script, cwd: home, args: {} } }), { mode: 0o600 });
  const { runTask } = await import("../daemon/tasks.ts");
  const seen: unknown[] = [];
  const job = { id: "j", task: "run", args: { command: "scan", args: {} }, contract: {} as any };
  const r = (await runTask(job, home, new AbortController().signal, (text, pct) => seen.push([text, pct]))) as { output: string };
  assert.equal(r.output.trim(), "done");
  assert.deepEqual(seen, [["starting", 10], ["half", 50]]);
});
