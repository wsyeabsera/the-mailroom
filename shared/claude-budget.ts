// The daily budget for Claude jobs, per key. Pure: no I/O, no clock, no globals. Used by the Hub (src/claude-budget.ts) and the daemon.
// A claude (and later `ask`) job costs turns and wall-clock time. The daemon measures both; the Hub adds them up per key per UTC day
// and refuses a new job once the day's total is at or over the contract's budget.

export const CLAUDE_TASKS: readonly string[] = ["claude", "ask"];
export const isClaudeTask = (task: unknown): boolean => typeof task === "string" && CLAUDE_TASKS.includes(task);

export const DEFAULT_CLAUDE_DAILY_TURNS = 100;
export const DEFAULT_CLAUDE_DAILY_MINUTES = 60;
export const MAX_CLAUDE_DAILY_TURNS = 100000;
export const MAX_CLAUDE_DAILY_MINUTES = 1440; // a whole day

export type Usage = { turns: number; ms: number };
export type ClaudeBudget = { turns: number; minutes: number };

/** The budget a contract grants (the safe defaults when the fields are missing, as in contracts stored before this existed). */
export const claudeBudget = (c: { claudeDailyTurns?: number; claudeDailyMinutes?: number }): ClaudeBudget => ({
  turns: typeof c.claudeDailyTurns === "number" ? c.claudeDailyTurns : DEFAULT_CLAUDE_DAILY_TURNS,
  minutes: typeof c.claudeDailyMinutes === "number" ? c.claudeDailyMinutes : DEFAULT_CLAUDE_DAILY_MINUTES,
});

/** The UTC day a moment belongs to, as YYYY-MM-DD. A job counts on the day it ended (when the daemon reported it). */
export const dayKey = (now: number): string => new Date(now).toISOString().slice(0, 10);

/** Cleans a usage report from the daemon (untrusted): whole non-negative numbers, capped. Anything else is null. */
export function parseUsage(v: unknown): Usage | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const turns = typeof o.turns === "number" && Number.isFinite(o.turns) ? Math.min(1000, Math.max(0, Math.round(o.turns))) : 0;
  const ms = typeof o.ms === "number" && Number.isFinite(o.ms) ? Math.min(86_400_000, Math.max(0, Math.round(o.ms))) : 0;
  return turns === 0 && ms === 0 ? null : { turns, ms };
}

export type BudgetState = { turnsLeft: number; msLeft: number; over: boolean; reason?: string };

/** What is left of today's budget, and the refusal reason if nothing is. Used up = at or over either limit. */
export function budgetState(budget: ClaudeBudget, used: Usage): BudgetState {
  const turnsLeft = Math.max(0, budget.turns - used.turns);
  const msLeft = Math.max(0, budget.minutes * 60_000 - used.ms);
  if (turnsLeft === 0)
    return { turnsLeft, msLeft, over: true, reason: `claude daily budget reached: ${used.turns} of ${budget.turns} turns used today (claudeDailyTurns). It resets at 00:00 UTC.` };
  if (msLeft === 0)
    return { turnsLeft, msLeft, over: true, reason: `claude daily budget reached: ${Math.round(used.ms / 60_000)} of ${budget.minutes} minutes used today (claudeDailyMinutes). It resets at 00:00 UTC.` };
  return { turnsLeft, msLeft, over: false };
}

/** The maxTurns a job should run with: what it asked for (or the contract ceiling), clipped to the turns left today (at least 1). */
export const clipMaxTurns = (asked: number, turnsLeft: number): number => Math.max(1, Math.min(asked, turnsLeft));

/** The wall-clock limit a job should run with: the usual timeout, clipped to the time left today (at least 1 second). */
export const clipTimeoutMs = (timeoutMs: number, msLeft: number | undefined): number =>
  typeof msLeft === "number" && Number.isFinite(msLeft) ? Math.max(1000, Math.min(timeoutMs, msLeft)) : timeoutMs;
