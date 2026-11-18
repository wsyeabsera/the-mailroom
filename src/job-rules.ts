// Small pure rules about jobs, kept out of hub.ts so they can be tested with node --test.

/** States that do not use up a key's daily limit: the parcel never ran (refused) or was withdrawn (cancelled). */
export const UNCOUNTED_STATES = ["refused", "cancelled"] as const;
export const UNCOUNTED_SQL = UNCOUNTED_STATES.map((s) => `'${s}'`).join(", ");

export const REQUEUE_REASON = "laptop disconnected";
export const NOT_RERUN_SAFE_REASON = "laptop dropped mid-run; not re-run-safe";

/** May a job that was running when the laptop dropped be run again? echo and read_file always; `run` only for commands
 *  the laptop flagged `rerunSafe` in its registry; write_file and claude never. */
export function isRerunSafe(task: string, args: Record<string, unknown> | undefined, safeCommands: readonly string[]): boolean {
  if (task === "echo" || task === "read_file") return true;
  if (task === "run") return typeof args?.command === "string" && safeCommands.includes(args.command);
  return false;
}

/** The `rerunSafe` list from a daemon hello: an array of command-name strings, else none. */
export function parseRerunSafe(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length <= 60).slice(0, 200) : [];
}

export const LABEL_MAX = 60;
/** Validates an optional job label: 1 to 60 characters of plain text (no control characters). Markup is allowed; it is only ever shown as text. */
export function parseLabel(v: unknown): { ok: true; label: string | null } | { ok: false; error: string } {
  if (v === undefined || v === null) return { ok: true, label: null };
  if (typeof v !== "string") return { ok: false, error: `label must be a string of 1 to ${LABEL_MAX} characters.` };
  const s = v.trim();
  if (s.length < 1 || s.length > LABEL_MAX) return { ok: false, error: `label must be 1 to ${LABEL_MAX} characters.` };
  if (/[\x00-\x1f\x7f]/.test(s)) return { ok: false, error: "label must be plain text on one line." };
  return { ok: true, label: s };
}
