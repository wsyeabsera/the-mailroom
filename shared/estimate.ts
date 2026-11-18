// A declared cost estimate on a command, prompt or workflow: "about 6 minutes, 40 Claude turns". Display help only: it limits nothing.
// Pure: no I/O.
export type Estimate = { minutes?: number; claudeTurns?: number };

const MAX_MINUTES = 24 * 60;
const MAX_TURNS = 100_000;

/** Cleans an estimate from a registry file or the laptop's report (untrusted display data). Anything unusable is dropped; no usable field = undefined. */
export function parseEstimate(raw: unknown): Estimate | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  const e: Estimate = {};
  if (typeof o.minutes === "number" && Number.isFinite(o.minutes) && o.minutes >= 0) e.minutes = Math.min(MAX_MINUTES, Math.round(o.minutes * 10) / 10);
  if (typeof o.claudeTurns === "number" && Number.isFinite(o.claudeTurns) && o.claudeTurns >= 0) e.claudeTurns = Math.min(MAX_TURNS, Math.round(o.claudeTurns));
  return e.minutes === undefined && e.claudeTurns === undefined ? undefined : e;
}

/** Does the estimate fit what is left of today's Claude budget? Unknown parts (no estimate, or not declared) count as fitting. */
export function estimateFits(e: Estimate | undefined, left: { turnsLeft: number; msLeft: number }): { fits: boolean; warning?: string } {
  if (!e) return { fits: true };
  if (e.claudeTurns !== undefined && e.claudeTurns > left.turnsLeft) return { fits: false, warning: `estimated ${e.claudeTurns} Claude turns, but only ${left.turnsLeft} are left in today's budget` };
  if (e.minutes !== undefined && e.minutes * 60_000 > left.msLeft) return { fits: false, warning: `estimated ${e.minutes} minutes, but only ${Math.floor(left.msLeft / 60_000)} are left in today's Claude budget` };
  return { fits: true };
}
