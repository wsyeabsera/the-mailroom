import test from "node:test";
import assert from "node:assert/strict";
import { laneOf, hintsFromTimeouts, parseHello, pickNext, laneKey } from "../shared/lanes.ts";

test("laneOf: fixed tasks and run hints", () => {
  for (const t of ["echo", "read_file", "write_file"]) assert.equal(laneOf(t, {}), "short");
  assert.equal(laneOf("claude", {}), "long");
  assert.equal(laneOf("mystery", {}), "long");
  assert.equal(laneOf("run", { command: "x" }), "long");
  assert.equal(laneOf("run", { command: "x" }, { x: "short" }), "short");
  assert.equal(laneOf("run", { command: "x" }, { x: "long" }), "long");
  assert.equal(laneOf("run", null, { x: "short" }), "long");
  assert.equal(laneOf("run", { command: "toString" }, {}), "long");
});

test("hintsFromTimeouts: 60s is the line", () => {
  assert.deepEqual(hintsFromTimeouts({ a: 60000, b: 60001, c: 1000, d: 0 }), { a: "short", b: "long", c: "short", d: "long" });
});

test("parseHello: missing field is an old daemon", () => {
  assert.equal(parseHello(undefined), null);
  assert.equal(parseHello("x"), null);
  assert.deepEqual(parseHello({}), { hints: {} });
  assert.deepEqual(parseHello({ commands: { a: "short", b: "bogus", c: "long" } }), { hints: { a: "short", c: "long" } });
});

const q = (...tasks: string[]) => tasks.map((task, i) => ({ id: i, task, args: {} }));

test("pickNext: a busy long lane does not block short, order kept within a lane", () => {
  const mode = { hints: {} };
  const jobs = q("claude", "echo", "claude", "echo");
  assert.equal(pickNext(jobs, new Set(), mode)?.id, 0);
  assert.equal(pickNext(jobs, new Set(["long"]), mode)?.id, 1);
  assert.equal(pickNext(jobs.slice(2), new Set(["short"]), mode)?.id, 2);
  assert.equal(pickNext(jobs, new Set(["long", "short"]), mode), null);
  assert.equal(pickNext(q("claude"), new Set(["long"]), mode), null);
});

test("pickNext: an old daemon has one lane", () => {
  assert.equal(pickNext(q("echo"), new Set(["all"]), null), null);
  assert.equal(pickNext(q("claude", "echo"), new Set(), null)?.id, 0);
  assert.equal(laneKey(false, "short"), "all");
});
