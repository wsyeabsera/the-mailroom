// Pure argument check for the "run" task, shared by the laptop daemon (daemon/commands.ts) and the Hub (refuse at submit).
// Same rules, same messages. No I/O.
export type ArgSpec = { type: "string" | "number" | "boolean" | "enum"; required?: boolean; maxLength?: number; values?: string[] };
export const STRING_MAX = 1000;

/** Checks `given` against the arg specs and builds the argv: `--name value` pairs, a boolean is a bare `--name` when true. */
export function buildArgv(specs: Record<string, ArgSpec>, given: unknown): { argv: string[] } | { error: string } {
  if (given === undefined || given === null) given = {};
  if (typeof given !== "object" || Array.isArray(given)) return { error: "args must be an object" };
  const g = given as Record<string, unknown>;
  for (const k of Object.keys(g)) if (!Object.hasOwn(specs, k)) return { error: `unknown arg “${k}”` };
  const argv: string[] = [];
  for (const [k, s] of Object.entries(specs)) {
    const v = g[k];
    if (v === undefined || v === null) {
      if (s.required) return { error: `arg “${k}” is required` };
      continue;
    }
    if (s.type === "boolean") {
      if (typeof v !== "boolean") return { error: `arg “${k}” must be true or false` };
      if (v) argv.push(`--${k}`);
    } else if (s.type === "number") {
      if (typeof v !== "number" || !Number.isFinite(v)) return { error: `arg “${k}” must be a number` };
      argv.push(`--${k}`, String(v));
    } else {
      if (typeof v !== "string" || v.includes("\0")) return { error: `arg “${k}” must be a string` };
      if (v.length > Math.min(s.maxLength ?? STRING_MAX, STRING_MAX)) return { error: `arg “${k}” is too long` };
      if (s.type === "enum" && !(s.values ?? []).includes(v)) return { error: `arg “${k}” must be one of ${(s.values ?? []).join(", ")}` };
      argv.push(`--${k}`, v);
    }
  }
  return { argv };
}
