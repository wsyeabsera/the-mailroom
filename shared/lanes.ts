// Two lanes so a long job never delays a quick one. Pure logic shared by the Hub and the daemon.
// `short`: echo, read_file, write_file, and run commands the laptop reported as short (timeoutMs <= 60000).
// `long`: claude, run (unless reported short), and anything else. Order is strict within a lane.
export type Lane = "short" | "long";
export type LaneHints = Record<string, Lane>; // run command name -> lane, reported by the daemon's hello
export const SHORT_TIMEOUT_MS = 60_000;
export const SINGLE_LANE = "all"; // the lane key used for an old daemon (hello without `lanes`)

const SHORT_TASKS = new Set(["echo", "read_file", "write_file"]);

export function laneOf(task: string, args: unknown, hints: LaneHints = {}): Lane {
  if (SHORT_TASKS.has(task)) return "short";
  if (task === "run") {
    const cmd = args && typeof args === "object" ? (args as Record<string, unknown>).command : undefined;
    if (typeof cmd === "string" && Object.hasOwn(hints, cmd) && hints[cmd] === "short") return "short";
  }
  return "long";
}

/** What the daemon reports in hello: every registered command whose timeoutMs is within the short limit is short. */
export function hintsFromTimeouts(timeouts: Record<string, number>): LaneHints {
  const out: LaneHints = {};
  for (const [name, ms] of Object.entries(timeouts)) out[name] = typeof ms === "number" && ms > 0 && ms <= SHORT_TIMEOUT_MS ? "short" : "long";
  return out;
}

/** Reads the hello `lanes` field. null = an old daemon (no field, or not usable): keep the single lane. */
export function parseHello(v: unknown): { hints: LaneHints } | null {
  if (!v || typeof v !== "object") return null;
  const c = (v as Record<string, unknown>).commands;
  const hints: LaneHints = {};
  if (c && typeof c === "object" && !Array.isArray(c)) {
    for (const [k, l] of Object.entries(c)) if (l === "short" || l === "long") hints[k] = l;
  }
  return { hints };
}

/** The key a job occupies: its lane, or one shared key for an old daemon. */
export const laneKey = (multi: boolean, lane: Lane): string => (multi ? lane : SINGLE_LANE);

/** From queued jobs in created order, the first whose lane is free (so the oldest job of each free lane). */
export function pickNext<T extends { task: string; args: unknown }>(queued: T[], busy: ReadonlySet<string>, mode: { hints: LaneHints } | null): T | null {
  for (const j of queued) {
    if (!busy.has(laneKey(!!mode, laneOf(j.task, j.args, mode?.hints)))) return j;
  }
  return null;
}
