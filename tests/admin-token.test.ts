import test from "node:test";
import assert from "node:assert/strict";
import { generateAdminToken, generateKey, generateDaemonCredential, tokenKind, hashToken, safeEqual, displayPrefix, validateTokenInput } from "../src/keys.ts";

test("admin tokens are mra_ + 32 base62 and unique", () => {
  const t = generateAdminToken();
  assert.match(t, /^mra_[0-9A-Za-z]{32}$/);
  assert.notEqual(t, generateAdminToken());
});

test("an admin token is its own kind; no other kind is one", () => {
  assert.equal(tokenKind(generateAdminToken()), "admin");
  assert.equal(tokenKind(generateKey()), "client");
  assert.equal(tokenKind(generateDaemonCredential()), "daemon");
  assert.equal(tokenKind("mra_short"), null);
  assert.equal(tokenKind("mra_" + "a".repeat(31) + "-"), null);
  assert.equal(tokenKind("mra_" + "a".repeat(33)), null);
});

test("hash, compare and display prefix", async () => {
  const t = generateAdminToken();
  const h = await hashToken(t);
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.ok(safeEqual(h, await hashToken(t)));
  assert.ok(!safeEqual(h, await hashToken(t + "x")));
  assert.equal(displayPrefix(t), t.slice(0, 12));
  assert.ok(displayPrefix(t).startsWith("mra_"));
});

test("scopes: read is added for write or approve, order is fixed", () => {
  const ok = (scopes: unknown) => { const r = validateTokenInput({ label: "x", scopes }); assert.ok(r.ok); return r.ok ? r.scopes : []; };
  assert.deepEqual(ok(["read"]), ["read"]);
  assert.deepEqual(ok(["write"]), ["read", "write"]);
  assert.deepEqual(ok(["approve"]), ["read", "approve"]);
  assert.deepEqual(ok(["approve", "write", "write"]), ["read", "write", "approve"]);
});

test("label and scopes validation messages", () => {
  const bad = (b: unknown) => { const r = validateTokenInput(b); assert.ok(!r.ok); return r.ok ? {} : r.errors; };
  assert.ok(bad({ label: "", scopes: ["read"] }).label);
  assert.ok(bad({ label: "   ", scopes: ["read"] }).label);
  assert.ok(bad({ label: "x".repeat(61), scopes: ["read"] }).label);
  assert.ok(bad({ label: "ok", scopes: [] }).scopes);
  assert.ok(bad({ label: "ok" }).scopes);
  assert.ok(bad({ label: "ok", scopes: ["admin"] }).scopes);
  assert.ok(bad({ label: "ok", scopes: ["read", 5] }).scopes);
  assert.ok(bad(null).label && bad(null).scopes);
  const r = validateTokenInput({ label: "  Claude  ", scopes: ["read"] });
  assert.ok(r.ok && r.label === "Claude");
});
