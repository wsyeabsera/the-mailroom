import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { checkLogin, recordFailure, clearFailures, LOGIN_TABLE, MAX_FAILS, WINDOW_S, type Sql } from "../src/login-limit.ts";

function mk(): Sql {
  const db = new DatabaseSync(":memory:");
  db.exec(LOGIN_TABLE);
  return {
    all: <T>(q: string, ...p: unknown[]) => db.prepare(q).all(...(p as never[])) as T[],
    run: (q: string, ...p: unknown[]) => void db.prepare(q).run(...(p as never[])),
  };
}

test("five wrong passwords lock, with retry_after", () => {
  const sql = mk();
  const t = 1_000_000;
  assert.deepEqual(checkLogin(sql, "ip", t), { locked: false, tries_left: 5 });
  for (let i = 1; i < MAX_FAILS; i++) assert.deepEqual(recordFailure(sql, "ip", t + i), { locked: false, tries_left: MAX_FAILS - i });
  const last = recordFailure(sql, "ip", t + 10);
  assert.equal(last.locked, true);
  assert.ok(last.locked && last.retry_after > WINDOW_S - 5 && last.retry_after <= WINDOW_S);
  assert.equal(checkLogin(sql, "ip", t + 20).locked, true);
});

test("other IPs are unaffected; window expiry and success reset", () => {
  const sql = mk();
  for (let i = 0; i < 5; i++) recordFailure(sql, "a", 1000);
  assert.equal(checkLogin(sql, "b", 2000).locked, false);
  assert.equal(checkLogin(sql, "a", 1000 + WINDOW_S * 1000 + 1).locked, false);
  clearFailures(sql, "a");
  assert.deepEqual(checkLogin(sql, "a", 2000), { locked: false, tries_left: 5 });
});
