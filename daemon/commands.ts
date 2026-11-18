// The laptop's registry of commands the "run" task may start: ~/.mailroom/commands.json, read fresh for every job.
// The laptop decides what runs. A job only names a command and supplies typed args; it never supplies a path or a shell line.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { COMMAND_RE } from "../shared/contract.ts";

export type ArgSpec = { type: "string" | "number" | "boolean" | "enum"; required?: boolean; maxLength?: number; values?: string[] };
export type Command = { script: string; args: Record<string, ArgSpec>; timeoutMs: number; cwd: string };

export const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const STRING_MAX = 1000;

/** Loads one command from the registry. Never throws; the error text is what the job is refused with. */
export function loadCommand(name: unknown, home = os.homedir()): { command: Command } | { error: string } {
  if (typeof name !== "string" || !COMMAND_RE.test(name)) return { error: "run needs a command name" };
  const file = path.join(home, ".mailroom", "commands.json");
  let reg: Record<string, any>;
  try {
    const st = fs.statSync(file);
    if (st.mode & 0o077) return { error: "commands.json on the laptop must be mode 0600" };
    reg = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return { error: `command “${name}” is not registered on this laptop` };
  }
  const c = reg && typeof reg === "object" && Object.hasOwn(reg, name) ? reg[name] : null;
  if (!c || typeof c !== "object") return { error: `command “${name}” is not registered on this laptop` };
  if (typeof c.script !== "string" || !path.isAbsolute(c.script) || c.script.includes("\0")) return { error: `command “${name}” has no absolute script path` };
  if (typeof c.cwd !== "string") return { error: `command “${name}” has no cwd` };
  const args: Record<string, ArgSpec> = {};
  for (const [k, s] of Object.entries<any>(c.args ?? {})) {
    if (!s || !["string", "number", "boolean", "enum"].includes(s.type) || !/^[\w-]{1,40}$/.test(k)) return { error: `command “${name}” has a bad arg “${k}”` };
    if (s.type === "enum" && (!Array.isArray(s.values) || s.values.some((v: unknown) => typeof v !== "string"))) return { error: `command “${name}” arg “${k}” needs values` };
    args[k] = { type: s.type, required: s.required === true, maxLength: typeof s.maxLength === "number" ? s.maxLength : undefined, values: s.values };
  }
  const timeoutMs = typeof c.timeoutMs === "number" && c.timeoutMs > 0 ? c.timeoutMs : DEFAULT_TIMEOUT_MS;
  return { command: { script: c.script, args, timeoutMs, cwd: c.cwd } };
}

/** Checks the job's args against the command's schema and builds the argv: `--name value` pairs, a boolean is a bare `--name` when true. */
export function buildArgv(cmd: Command, given: unknown): { argv: string[] } | { error: string } {
  if (given === undefined || given === null) given = {};
  if (typeof given !== "object" || Array.isArray(given)) return { error: "args must be an object" };
  const g = given as Record<string, unknown>;
  for (const k of Object.keys(g)) if (!Object.hasOwn(cmd.args, k)) return { error: `unknown arg “${k}”` };
  const argv: string[] = [];
  for (const [k, s] of Object.entries(cmd.args)) {
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
      if (s.type === "enum" && !s.values!.includes(v)) return { error: `arg “${k}” must be one of ${s.values!.join(", ")}` };
      argv.push(`--${k}`, v);
    }
  }
  return { argv };
}
