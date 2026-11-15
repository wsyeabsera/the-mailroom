import test from "node:test";
import assert from "node:assert/strict";
import { signSession, verifySession, cookieValue, sessionCookie, SESSION_COOKIE } from "../src/session.ts";

const now = Date.parse("2026-11-15T12:00:00Z");
const exp = Math.floor(now / 1000) + 3600;

test("a signed session verifies until it expires", async () => {
  const v = await signSession("s3cret", exp);
  assert.ok(await verifySession("s3cret", v, now));
  assert.ok(!(await verifySession("s3cret", v, now + 2 * 3600 * 1000)));
});

test("wrong secret, tampered exp, garbage and no secret fail", async () => {
  const v = await signSession("s3cret", exp);
  assert.ok(!(await verifySession("other", v, now)));
  assert.ok(!(await verifySession("s3cret", `${exp + 1}.${v.split(".")[1]}`, now)));
  assert.ok(!(await verifySession("s3cret", "nope", now)));
  assert.ok(!(await verifySession(undefined, v, now)));
  assert.ok(!(await verifySession("s3cret", undefined, now)));
});

test("a client key is not a session", async () => {
  assert.ok(!(await verifySession("s3cret", "mr_live_" + "a".repeat(32), now)));
});

test("cookie helpers", () => {
  assert.equal(cookieValue(`a=1; ${SESSION_COOKIE}=xyz; b=2`), "xyz");
  assert.equal(cookieValue("a=1"), undefined);
  const c = sessionCookie("v", 10, true);
  assert.match(c, /HttpOnly/);
  assert.match(c, /SameSite=Strict/);
  assert.match(c, /Secure/);
  assert.doesNotMatch(sessionCookie("v", 10, false), /Secure/);
});
