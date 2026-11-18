import test from "node:test";
import assert from "node:assert/strict";
import { fingerprint, IDEMPOTENCY_TTL_MS, idempotencyFresh, parseIdempotencyKey, stableStringify } from "../src/idempotency.ts";

test("keys: absent, valid, invalid", () => {
  assert.equal(parseIdempotencyKey(null), null);
  assert.equal(parseIdempotencyKey(" scan-2026-11-18 "), "scan-2026-11-18");
  assert.equal(parseIdempotencyKey(""), "invalid");
  assert.equal(parseIdempotencyKey("a b"), "invalid");
  assert.equal(parseIdempotencyKey("x".repeat(201)), "invalid");
  assert.equal(parseIdempotencyKey("x".repeat(200)), "x".repeat(200));
});

test("the fingerprint ignores key order but sees any difference in task or args", () => {
  assert.equal(stableStringify({ b: 1, a: { d: [1, { y: 1, x: 2 }], c: null } }), '{"a":{"c":null,"d":[1,{"x":2,"y":1}]},"b":1}');
  assert.equal(fingerprint("run", { command: "scan", args: { a: 1, b: 2 } }), fingerprint("run", { args: { b: 2, a: 1 }, command: "scan" }));
  assert.notEqual(fingerprint("echo", { text: "a" }), fingerprint("echo", { text: "b" }));
  assert.notEqual(fingerprint("echo", { text: "a" }), fingerprint("read_file", { text: "a" }));
});

test("a key is honoured for 24 hours", () => {
  assert.equal(idempotencyFresh(0, IDEMPOTENCY_TTL_MS - 1), true);
  assert.equal(idempotencyFresh(0, IDEMPOTENCY_TTL_MS), false);
});
