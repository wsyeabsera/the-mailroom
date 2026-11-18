// The laptop's registry of commands the "run" task may start: ~/.mailroom/commands.json, read fresh for every job.
// The laptop decides what runs. A job only names a command and supplies typed args; it never supplies a path or a shell line.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildArgv as buildArgvShared } from "../shared/args.ts";
import { COMMAND_RE } from "../shared/contract.ts";
import { sanitizeReport, type ArgSpec, type ReportedCommand } from "../shared/projects.ts";

export type { ArgSpec, ReportedCommand };
export type Command = { script: string; args: Record<string, ArgSpec>; timeoutMs: number; cwd: string; rerunSafe: boolean; project?: string; output?: "json" };

export const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

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
  if (c.output !== undefined && c.output !== "json") return { error: `command “${name}” has a bad output (only "json" is known)` };
  const timeoutMs = typeof c.timeoutMs === "number" && c.timeoutMs > 0 ? c.timeoutMs : DEFAULT_TIMEOUT_MS;
  return { command: { script: c.script, args, timeoutMs, cwd: c.cwd, rerunSafe: c.rerunSafe === true, ...(c.output === "json" ? { output: "json" as const } : {}), ...(typeof c.project === "string" ? { project: c.project } : {}) } };
}

/** What the daemon tells the Hub on hello: name, project tag, arg specs and timeout for every registered command.
 *  Never the script path or cwd. A missing, unreadable or non-0600 registry reports nothing (same refusal as loading a job's command). */
export function listReport(home = os.homedir()): ReportedCommand[] {
  const file = path.join(home, ".mailroom", "commands.json");
  let reg: unknown;
  try {
    if (fs.statSync(file).mode & 0o077) return [];
    reg = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return [];
  }
  if (!reg || typeof reg !== "object" || Array.isArray(reg)) return [];
  const out: unknown[] = [];
  for (const name of Object.keys(reg)) {
    const r = loadCommand(name, home);
    if ("error" in r) continue;
    out.push({ name, project: r.command.project ?? null, args: r.command.args, timeoutMs: r.command.timeoutMs });
  }
  return sanitizeReport(out);
}

/** Every registered command's timeoutMs, for the hello lane report. Never throws; an unreadable registry reports nothing (all runs are long). */
export function commandTimeouts(home = os.homedir()): Record<string, number> {
  const out: Record<string, number> = {};
  try {
    const reg = JSON.parse(fs.readFileSync(path.join(home, ".mailroom", "commands.json"), "utf8"));
    for (const [name, c] of Object.entries<any>(reg ?? {})) out[name] = c && typeof c.timeoutMs === "number" && c.timeoutMs > 0 ? c.timeoutMs : DEFAULT_TIMEOUT_MS;
  } catch { /* no registry */ }
  return out;
}

/** Checks the job's args against the command's schema and builds the argv: `--name value` pairs, a boolean is a bare `--name` when true. */
export function buildArgv(cmd: Command, given: unknown): { argv: string[] } | { error: string } {
  return buildArgvShared(cmd.args, given);
}

/** Names of the registered commands flagged `rerunSafe: true`. Sent to the Hub in the hello, read when the daemon connects. */
export function rerunSafeCommands(home = os.homedir()): string[] {
  let names: string[];
  try {
    names = Object.keys(JSON.parse(fs.readFileSync(path.join(home, ".mailroom", "commands.json"), "utf8")));
  } catch {
    return [];
  }
  return names.filter(n => { const c = loadCommand(n, home); return "command" in c && c.command.rerunSafe; });
}
