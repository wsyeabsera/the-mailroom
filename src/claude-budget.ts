// Hub side of the daily claude budget: the claude_usage table and the few reads/writes hub.ts needs. The rules are in shared/claude-budget.ts.
import { budgetState, claudeBudget, dayKey, type BudgetState, type Usage } from "../shared/claude-budget.ts";
import type { Sql } from "./login-limit.ts";

type Row = Record<string, any>;
const KEEP_DAYS = 90;

export const CLAUDE_USAGE_TABLE = "CREATE TABLE IF NOT EXISTS claude_usage (key_id TEXT NOT NULL, day TEXT NOT NULL, turns INTEGER NOT NULL DEFAULT 0, ms INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (key_id, day))";

export function ensureClaudeUsageSchema(sql: Sql) { sql.run(CLAUDE_USAGE_TABLE); }

/** Adds a finished (or cancelled, or failed) job's usage to its key's total for the UTC day it ended. */
export function addUsage(sql: Sql, keyId: string, usage: Usage, now = Date.now()) {
  sql.run("INSERT INTO claude_usage (key_id, day, turns, ms) VALUES (?, ?, ?, ?) ON CONFLICT (key_id, day) DO UPDATE SET turns = turns + excluded.turns, ms = ms + excluded.ms", keyId, dayKey(now), usage.turns, usage.ms);
  sql.run("DELETE FROM claude_usage WHERE day < ?", dayKey(now - KEEP_DAYS * 86_400_000));
}

export function usageToday(sql: Sql, keyId: string, now = Date.now()): Usage {
  const r = sql.all<Row>("SELECT turns, ms FROM claude_usage WHERE key_id = ? AND day = ?", keyId, dayKey(now))[0];
  return { turns: r?.turns ?? 0, ms: r?.ms ?? 0 };
}

/** Today's usage against the contract's budget, for the admin API. */
export function usageSummary(sql: Sql, keyId: string, contract: { claudeDailyTurns?: number; claudeDailyMinutes?: number }, now = Date.now()) {
  const used = usageToday(sql, keyId, now);
  const budget = claudeBudget(contract);
  const st = budgetState(budget, used);
  return { day: dayKey(now), turns: used.turns, ms: used.ms, minutes: Math.round((used.ms / 60_000) * 10) / 10, budget: { turns: budget.turns, minutes: budget.minutes }, turns_left: st.turnsLeft, over: st.over };
}

/** The state of today's budget for a key under a contract (refusal reason when it is used up). */
export function budgetFor(sql: Sql, keyId: string, contract: { claudeDailyTurns?: number; claudeDailyMinutes?: number }, now = Date.now()): BudgetState {
  return budgetState(claudeBudget(contract), usageToday(sql, keyId, now));
}
