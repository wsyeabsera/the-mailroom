import test from "node:test";
import assert from "node:assert/strict";
import { laneOf, hintsFromTimeouts, parseHello, pickNext, laneKey } from "../shared/lanes.ts";

const q = (...tasks: string[]) => tasks.map((task, i) => ({ id: i, task, args: {} }));

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

test("laneOf: mcp_list and mcp_call have their own lane, claude and ask stay long", () => {
  assert.equal(laneOf("mcp_list", {}), "mcp");
  assert.equal(laneOf("mcp_call", { server: "s", tool: "t" }), "mcp");
  assert.equal(laneOf("mcp_call", { server: "s", tool: "t" }, { mcp_call: "short" }), "mcp"); // hints cannot move it
  assert.equal(laneOf("claude", {}), "long");
  assert.equal(laneOf("ask", {}), "long");
  assert.equal(laneOf("run", { command: "mcp_call" }, {}), "long");
});

test("pickNext: a running Claude job does not block mcp jobs; mcp jobs run one at a time and do not block short", () => {
  const mode = { hints: {} };
  const jobs = q("claude", "mcp_list", "mcp_call", "echo");
  assert.equal(pickNext(jobs, new Set(["long"]), mode)?.id, 1);
  assert.equal(pickNext(jobs.slice(2), new Set(["long", "mcp"]), mode)?.id, 3); // second mcp job waits; echo goes
  assert.equal(pickNext(q("mcp_call", "mcp_call"), new Set(["mcp"]), mode), null);
  assert.equal(pickNext(q("mcp_call", "mcp_call"), new Set(), mode)?.id, 0); // oldest first
  assert.equal(pickNext(q("claude"), new Set(["mcp"]), mode)?.id, 0);
  assert.equal(pickNext(q("mcp_list"), new Set(["all"]), null), null); // an old daemon: one lane
  assert.equal(laneKey(true, "mcp"), "mcp");
  assert.equal(laneKey(false, "mcp"), "all");
});

test("hintsFromTimeouts: 60s is the line", () => {
  assert.deepEqual(hintsFromTimeouts({ a: 60000, b: 60001, c: 1000, d: 0 }), { a: "short", b: "long", c: "short", d: "long" });
});

test("parseHello: missing field is an old daemon", () => {
  assert.equal(parseHello(undefined), null);
  assert.equal(parseHello("x"), null);
  assert.deepEqual(parseHello({}), { hints: {} });
  assert.deepEqual(parseHello({ commands: { a: "short", b: "bogus", c: "long", d: "mcp" } }), { hints: { a: "short", c: "long" } });
});


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
