import test from "node:test";
import assert from "node:assert/strict";
import { generateKey, generateDaemonCredential, hashToken, safeEqual, safeEqualSecret, displayPrefix, credentialHint, tokenKind, bearer, makeId } from "../src/keys.ts";

test("keys have the right shape and are unique", () => {
  const a = generateKey();
  assert.match(a, /^mr_live_[0-9A-Za-z]{32}$/);
  assert.notEqual(a, generateKey());
  assert.match(generateDaemonCredential(), /^mrd_[0-9A-Za-z]{32}$/);
});

test("a client key is never a daemon credential and the reverse", () => {
  assert.equal(tokenKind(generateKey()), "client");
  assert.equal(tokenKind(generateDaemonCredential()), "daemon");
  assert.equal(tokenKind("mr_live_short"), null);
  assert.equal(tokenKind("mrd_" + "a".repeat(31) + "!"), null);
});

test("hash is sha256 hex and deterministic", async () => {
  assert.equal(await hashToken("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("safeEqual", async () => {
  assert.ok(safeEqual("abc", "abc"));
  assert.ok(!safeEqual("abc", "abd"));
  assert.ok(!safeEqual("abc", "abcd"));
  assert.ok(await safeEqualSecret("x", "x"));
  assert.ok(!(await safeEqualSecret("x", "y")));
});

test("display prefix, hint, bearer, ids", () => {
  assert.equal(displayPrefix("mr_live_9aKdXXXXXXXX"), "mr_live_9aKd");
  assert.equal(credentialHint("mrd_" + "x".repeat(28) + "9a3f"), "mrd_...9a3f");
  assert.equal(bearer("Bearer abc"), "abc");
  assert.equal(bearer("Basic abc"), null);
  assert.equal(bearer(null), null);
  assert.equal(makeId("p_", 0), "p_1000");
  assert.equal(makeId("p_", 1), "p_1001");
  assert.match(makeId("p_", 5000), /^p_[0-9a-z]{4,8}$/);
});
