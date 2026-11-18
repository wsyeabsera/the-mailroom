import { test } from "node:test";
import assert from "node:assert/strict";
import { parseProgressLine, throttle } from "../daemon/progress.ts";

test("parses text only, pct + text, and rejects others", () => {
  assert.deepEqual(parseProgressLine("MAILROOM_PROGRESS checking files"), { text: "checking files" });
  assert.deepEqual(parseProgressLine("MAILROOM_PROGRESS 40 checked 40 of 100\r"), { text: "checked 40 of 100", pct: 40 });
  assert.deepEqual(parseProgressLine("MAILROOM_PROGRESS 12.5"), { text: "", pct: 12.5 });
  assert.deepEqual(parseProgressLine("MAILROOM_PROGRESS 250 big"), { text: "250 big" });
  assert.equal(parseProgressLine("hello"), null);
  assert.equal(parseProgressLine("MAILROOM_PROGRESS "), null);
  assert.equal(parseProgressLine("MAILROOM_PROGRESSX 1"), null);
});

test("text is capped at 500 chars", () => {
  assert.equal(parseProgressLine("MAILROOM_PROGRESS " + "x".repeat(900))!.text.length, 500);
});

test("throttle sends first now, then only the latest after the window", async () => {
  const got: number[] = [];
  const t = throttle<number>(v => got.push(v), 50);
  t.push(1);
  t.push(2);
  t.push(3);
  assert.deepEqual(got, [1]);
  await new Promise(r => setTimeout(r, 80));
  assert.deepEqual(got, [1, 3]);
  t.stop();
});
