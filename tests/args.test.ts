import { test } from "node:test";
import assert from "node:assert/strict";
import { buildArgv } from "../shared/args.ts";
import { buildArgv as daemonBuildArgv } from "../daemon/commands.ts";
import { Projects, storeReport } from "../src/projects.ts";

const S: any = {
  who: { type: "string", required: true, maxLength: 5 },
  mode: { type: "enum", values: ["fast", "slow"] },
  n: { type: "number" },
  loud: { type: "boolean" },
};

test("buildArgv: unknown arg, bad enum, wrong type, required, length", () => {
  assert.deepEqual(buildArgv(S, { who: "a", extra: 1 }), { error: "unknown arg “extra”" });
  assert.deepEqual(buildArgv(S, { who: "a", mode: "warp" }), { error: "arg “mode” must be one of fast, slow" });
  assert.deepEqual(buildArgv(S, { who: 5 }), { error: "arg “who” must be a string" });
  assert.deepEqual(buildArgv(S, { who: "a", n: "3" }), { error: "arg “n” must be a number" });
  assert.deepEqual(buildArgv(S, { who: "a", loud: "yes" }), { error: "arg “loud” must be true or false" });
  assert.deepEqual(buildArgv(S, {}), { error: "arg “who” is required" });
  assert.deepEqual(buildArgv(S, { who: "toolong" }), { error: "arg “who” is too long" });
  assert.deepEqual(buildArgv(S, [] as any), { error: "args must be an object" });
  assert.deepEqual(buildArgv(S, { who: "a", mode: "fast", n: 2, loud: true }), { argv: ["--who", "a", "--mode", "fast", "--n", "2", "--loud"] });
});

test("the daemon's buildArgv is the shared one", () => {
  const cmd = { script: "/x", args: S, timeoutMs: 1, cwd: "/" };
  for (const given of [{ who: 5 }, { who: "a", mode: "no" }, { who: "a", z: 1 }, { who: "ok", loud: true }]) assert.deepEqual(daemonBuildArgv(cmd, given), buildArgv(S, given));
});

// A tiny sql stand-in holding only the laptop_report row.
function fakeProjects() {
  let row: Record<string, unknown> | null = null;
  const sql: any = {
    run: (q: string, ...p: unknown[]) => { if (q.startsWith("INSERT INTO laptop_report")) row = { commands: p[0], reported_at: p[1] }; },
    all: (q: string) => (q.includes("laptop_report") && row ? [row] : []),
  };
  return { sql, projects: new Projects({ sql } as any) };
}

test("Hub side: argError uses the reported specs; no report or unknown command means the laptop decides", () => {
  const { sql, projects } = fakeProjects();
  assert.equal(projects.argError("greet", { who: 5 }), null, "schema missing");
  storeReport(sql, [{ name: "greet", args: { who: { type: "string", required: true }, mode: { type: "enum", values: ["a", "b"] } } }]);
  assert.equal(projects.argError("greet", { who: 5 }), "arg “who” must be a string");
  assert.equal(projects.argError("greet", { who: "x", mode: "c" }), "arg “mode” must be one of a, b");
  assert.equal(projects.argError("greet", { who: "x", nope: 1 }), "unknown arg “nope”");
  assert.equal(projects.argError("greet", { who: "x", mode: "a" }), null);
  assert.equal(projects.argError("other", { anything: 1 }), null, "a command the laptop has not reported is left to the laptop");
  assert.equal(projects.argError(undefined, {}), null);
});
