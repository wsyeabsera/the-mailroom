import test from "node:test";
import assert from "node:assert/strict";
import { markerBytes, planResult, resultCutoff, resultExpired } from "../src/results.ts";
import { BIG_RESULT_TTL_MS, INLINE_RESULT_BYTES, MAX_RESULT_BYTES } from "../shared/limits.ts";

test("small results stay inline, big ones go to the separate table, over the cap is refused", () => {
  const small = JSON.stringify({ content: "x".repeat(1000) });
  assert.deepEqual(planResult(small), { kind: "inline", json: small });
  const big = JSON.stringify({ content: "x".repeat(1024 * 1024) }); // 1 MB
  const p = planResult(big);
  assert.equal(p.kind, "stored");
  if (p.kind === "stored") {
    assert.equal(p.body, big);
    assert.equal(markerBytes(p.marker), big.length);
    assert.ok(p.marker.length < 100);
  }
  assert.equal(planResult(JSON.stringify("x".repeat(MAX_RESULT_BYTES))).kind, "too_large");
  assert.equal(planResult("x".repeat(INLINE_RESULT_BYTES)).kind, "inline");
  assert.equal(planResult("x".repeat(INLINE_RESULT_BYTES + 1)).kind, "stored");
});

test("size is in bytes, not characters", () => {
  assert.equal(planResult("é".repeat(INLINE_RESULT_BYTES / 2 + 1)).kind, "stored");
});

test("markerBytes only recognises the marker", () => {
  assert.equal(markerBytes('{"echo":"hi"}'), null);
  assert.equal(markerBytes(null), null);
  assert.equal(markerBytes('{"$stored":{"bytes":300000}}'), 300000);
});

test("stored results expire after 7 days", () => {
  assert.equal(BIG_RESULT_TTL_MS, 7 * 86400_000);
  const now = 10 * 86400_000;
  assert.equal(resultExpired(now - BIG_RESULT_TTL_MS + 1, now), false);
  assert.equal(resultExpired(now - BIG_RESULT_TTL_MS, now), true);
  assert.equal(resultCutoff(now), now - BIG_RESULT_TTL_MS);
});
