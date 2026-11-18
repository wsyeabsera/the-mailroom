import test from "node:test";
import assert from "node:assert/strict";
import { isRerunSafe, LABEL_MAX, parseLabel, parseRerunSafe, UNCOUNTED_SQL, UNCOUNTED_STATES } from "../src/job-rules.ts";

test("cancelled and refused parcels do not count toward the daily limit; everything else does", () => {
  assert.deepEqual([...UNCOUNTED_STATES], ["refused", "cancelled"]);
  assert.equal(UNCOUNTED_SQL, "'refused', 'cancelled'");
});

test("re-run-safe: echo and read_file yes, write_file and claude no, run only for flagged commands", () => {
  assert.equal(isRerunSafe("echo", {}, []), true);
  assert.equal(isRerunSafe("read_file", { path: "x" }, []), true);
  assert.equal(isRerunSafe("write_file", { path: "x", content: "y" }, ["write_file"]), false);
  assert.equal(isRerunSafe("claude", { prompt: "p" }, []), false);
  assert.equal(isRerunSafe("run", { command: "scan" }, []), false);
  assert.equal(isRerunSafe("run", { command: "scan" }, ["scan"]), true);
  assert.equal(isRerunSafe("run", { command: "other" }, ["scan"]), false);
  assert.equal(isRerunSafe("run", {}, ["scan"]), false);
  assert.equal(isRerunSafe("mystery", {}, ["mystery"]), false);
});

test("the hello rerunSafe field is sanitised", () => {
  assert.deepEqual(parseRerunSafe(["a", 5, "b"]), ["a", "b"]);
  assert.deepEqual(parseRerunSafe(undefined), []);
  assert.deepEqual(parseRerunSafe("scan"), []);
});

test("label: optional, 1 to 60 plain characters", () => {
  assert.deepEqual(parseLabel(undefined), { ok: true, label: null });
  assert.deepEqual(parseLabel("  test "), { ok: true, label: "test" });
  assert.equal(parseLabel("x".repeat(LABEL_MAX)).ok, true);
  assert.equal(parseLabel("x".repeat(LABEL_MAX + 1)).ok, false);
  assert.equal(parseLabel("").ok, false);
  assert.equal(parseLabel("   ").ok, false);
  assert.equal(parseLabel(5).ok, false);
  assert.equal(parseLabel("a\nb").ok, false);
  // markup is accepted as text; the UI only ever shows it as text
  assert.deepEqual(parseLabel("<script>alert(1)</script>"), { ok: true, label: "<script>alert(1)</script>" });
});
