import test from "node:test";
import assert from "node:assert/strict";
import { budgetState, claudeBudget, clipMaxTurns, clipTimeoutMs, dayKey, isClaudeTask, parseUsage } from "../shared/claude-budget.ts";
import { validateContract } from "../shared/contract.ts";

test("claudeBudget: defaults when the contract has none", () => {
  assert.deepEqual(claudeBudget({}), { turns: 100, minutes: 60 });
  assert.deepEqual(claudeBudget({ claudeDailyTurns: 7, claudeDailyMinutes: 3 }), { turns: 7, minutes: 3 });
});

test("dayKey buckets by UTC day", () => {
  assert.equal(dayKey(Date.parse("2026-11-15T23:59:59.999Z")), "2026-11-15");
  assert.equal(dayKey(Date.parse("2026-11-16T00:00:00.000Z")), "2026-11-16");
});

test("budgetState: under, at and over each limit", () => {
  const b = { turns: 10, minutes: 2 };
  assert.deepEqual(budgetState(b, { turns: 3, ms: 60_000 }), { turnsLeft: 7, msLeft: 60_000, over: false });
  const atTurns = budgetState(b, { turns: 10, ms: 0 });
  assert.equal(atTurns.over, true);
  assert.match(atTurns.reason!, /10 of 10 turns.*claudeDailyTurns/);
  assert.equal(budgetState(b, { turns: 50, ms: 0 }).turnsLeft, 0);
  const atMs = budgetState(b, { turns: 1, ms: 120_000 });
  assert.equal(atMs.over, true);
  assert.match(atMs.reason!, /2 of 2 minutes.*claudeDailyMinutes/);
  assert.equal(budgetState(b, { turns: 1, ms: 119_999 }).over, false);
});

test("clipMaxTurns and clipTimeoutMs", () => {
  assert.equal(clipMaxTurns(10, 4), 4);
  assert.equal(clipMaxTurns(3, 40), 3);
  assert.equal(clipMaxTurns(10, 0), 1);
  assert.equal(clipTimeoutMs(300_000, 60_000), 60_000);
  assert.equal(clipTimeoutMs(300_000, 10), 1000);
  assert.equal(clipTimeoutMs(300_000, undefined), 300_000);
});

test("parseUsage cleans an untrusted report", () => {
  assert.deepEqual(parseUsage({ turns: 3, ms: 1234.6 }), { turns: 3, ms: 1235 });
  assert.deepEqual(parseUsage({ turns: -5, ms: 10 }), { turns: 0, ms: 10 });
  assert.deepEqual(parseUsage({ turns: 1e9, ms: 1e12 }), { turns: 1000, ms: 86_400_000 });
  assert.equal(parseUsage({ turns: "x" }), null);
  assert.equal(parseUsage(null), null);
  assert.equal(parseUsage({ turns: 0, ms: 0 }), null);
});

test("isClaudeTask covers claude and ask only", () => {
  assert.equal(isClaudeTask("claude"), true);
  assert.equal(isClaudeTask("ask"), true);
  assert.equal(isClaudeTask("run"), false);
  assert.equal(isClaudeTask(undefined), false);
});

test("validateContract: budget fields default, validate and are stored", () => {
  const base = { name: "n", folders: ["~/a"], tasks: ["claude"], dailyLimit: 5, expires: null, approval: [] };
  const d = validateContract(base);
  assert.ok(d.ok && d.contract.claudeDailyTurns === 100 && d.contract.claudeDailyMinutes === 60);
  const g = validateContract({ ...base, claudeDailyTurns: 20, claudeDailyMinutes: 15 });
  assert.ok(g.ok && g.contract.claudeDailyTurns === 20 && g.contract.claudeDailyMinutes === 15);
  for (const bad of [0, -1, 1.5, "10", 100001]) {
    const r = validateContract({ ...base, claudeDailyTurns: bad });
    assert.ok(!r.ok && r.errors.claudeDailyTurns, `turns ${String(bad)}`);
  }
  const m = validateContract({ ...base, claudeDailyMinutes: 1441 });
  assert.ok(!m.ok && m.errors.claudeDailyMinutes);
});
