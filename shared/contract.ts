// The contract rules, shared by the gateway (Worker) and the daemon. Pure: no I/O, no clock, no globals.
// A contract says what a key may do. The gateway checks it, and the daemon runs the same check again on the contract the Hub
// sends with each job (with real paths and the laptop's home and clock). The laptop ceiling (daemon/policy.ts) is applied by the daemon on top.

import { validateCallbackPrefixes, type UrlOpts } from "./callback.ts";

export const TASKS =["echo", "read_file", "write_file", "claude", "run"] as const;
export type TaskName = (typeof TASKS)[number];

export type Contract = {
  name: string;
  folders: string[]; // "~/x" or "/x"; a job path must be inside one of them
  tasks: string[]; // subset of TASKS
  dailyLimit: number; // whole parcels per UTC day, 1..100000
  expires: string | null; // ISO date or datetime; null = never
  approval: string[]; // tasks that wait for the owner before they run
  commands?: string[]; // names the "run" task may use (registered on the laptop); missing in older contracts = none
  claudeTools?: string[]; // ceiling on a claude job's allowedTools, and what a job with no allowedTools gets; missing = DEFAULT_CLAUDE_TOOLS
  claudeMaxTurns?: number; // ceiling on a claude job's maxTurns, and what a job with no maxTurns gets; missing = DEFAULT_CLAUDE_MAX_TURNS
  callbackUrls?: string[]; // https prefixes (ending in /) a job's callback_url must start with; missing = none (shared/callback.ts)
};

/** Safe defaults for contracts stored before the claude ceilings existed: read-only tools, a short run. */
export const DEFAULT_CLAUDE_TOOLS: readonly string[] = ["Read", "Glob", "Grep"];
export const DEFAULT_CLAUDE_MAX_TURNS = 10;
export const MAX_CLAUDE_TURNS = 50;
export const CLAUDE_TOOL_RE = /^[\w:*() .\-]{1,100}$/;
/** The claude ceilings a contract grants (the defaults when the fields are missing). */
export const claudeCeiling = (c: { claudeTools?: string[]; claudeMaxTurns?: number }) => ({
  tools: Array.isArray(c.claudeTools) ? c.claudeTools : [...DEFAULT_CLAUDE_TOOLS],
  maxTurns: typeof c.claudeMaxTurns === "number" ? c.claudeMaxTurns : DEFAULT_CLAUDE_MAX_TURNS,
});

export type Job = { task: string; args: Record<string, unknown> };

export type Verdict =
  | { verdict: "allow" }
  | { verdict: "approve" } // allowed, but waits for the owner
  | { verdict: "refuse"; reason: string };

export type CheckContext = {
  now: number; // epoch ms
  usedToday: number; // parcels this key already sent today (UTC)
  home?: string; // the laptop's home dir; the daemon passes it, the gateway does not
};

export type ValidationResult = { ok: true; contract: Contract } | { ok: false; errors: Record<string, string> };

const NAME_RE = /^[\w .()-]{1,60}$/;
export const COMMAND_RE = /^[\w.-]{1,60}$/;

/** "~/a/../b" -> "~/b", "/a//b/" -> "/a/b". Returns null for a relative path or one that climbs out of its root. */
export function normalizePath(p: string, home?: string): string | null {
  if (typeof p !== "string" || p.length === 0 || p.length > 1000 || p.includes("\0")) return null;
  let root: string;
  let rest: string;
  if (p === "~" || p.startsWith("~/")) {
    root = home ? home.replace(/\/+$/, "") : "~";
    rest = p.slice(1);
  } else if (p.startsWith("/")) {
    root = "";
    rest = p;
  } else return null;
  const out: string[] = [];
  for (const seg of rest.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length === 0) return null;
      out.pop();
    } else out.push(seg);
  }
  const joined = out.join("/");
  if (root === "") return joined ? `/${joined}` : "/";
  return joined ? `${root}/${joined}` : root || "/";
}

/** Is path inside folder (or equal to it)? Both must already be normalized. */
export function inside(path: string, folder: string): boolean {
  if (folder === "/") return path.startsWith("/");
  return path === folder || path.startsWith(`${folder}/`);
}

/** Validates an editor or API payload. The messages are the copy the contract editor shows. */
export function validateContract(raw: unknown, urlOpts: UrlOpts = {}): ValidationResult {
  const errors: Record<string, string> = {};
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;

  const name = typeof o.name === "string" ? o.name.trim() : "";
  if (!NAME_RE.test(name)) errors.name = "Give it a short name (letters, numbers, spaces).";

  const foldersIn = Array.isArray(o.folders) ? o.folders : null;
  const folders: string[] = [];
  if (!foldersIn || foldersIn.length === 0) errors.folders = "Allow at least one folder.";
  else
    for (const f of foldersIn) {
      const n = typeof f === "string" ? normalizePath(f.trim()) : null;
      if (n === null || n === "~" || n === "/") {
        errors.folders = `Folders must start with ~/ or /. “${String(f)}” could mean anywhere.`;
        break;
      }
      folders.push(n);
    }

  const tasksIn = Array.isArray(o.tasks) ? o.tasks : null;
  const tasks: string[] = [];
  if (!tasksIn || tasksIn.length === 0) errors.tasks = "Allow at least one task.";
  else
    for (const t of tasksIn) {
      if (typeof t !== "string" || !(TASKS as readonly string[]).includes(t)) {
        errors.tasks = `Unknown task “${String(t)}”.`;
        break;
      }
      if (!tasks.includes(t)) tasks.push(t);
    }

  const dl = o.dailyLimit;
  if (typeof dl !== "number" || !Number.isInteger(dl) || dl < 1 || dl > 100000) errors.dailyLimit = "Use a whole number, like 50.";

  let expires: string | null = null;
  if (o.expires !== null && o.expires !== undefined && o.expires !== "") {
    const t = typeof o.expires === "string" ? Date.parse(o.expires) : NaN;
    if (Number.isNaN(t)) errors.expires = "Use a date like 2026-12-31, or leave it empty for never.";
    else expires = new Date(t).toISOString();
  }

  const apprIn = Array.isArray(o.approval) ? o.approval : [];
  const approval: string[] = [];
  for (const a of apprIn) {
    if (typeof a !== "string" || !tasks.includes(a)) {
      errors.approval = "Approval can only be set on tasks the contract allows.";
      break;
    }
    if (!approval.includes(a)) approval.push(a);
  }

  const cmdIn = Array.isArray(o.commands) ? o.commands : o.commands === undefined || o.commands === null ? [] : null;
  const commands: string[] = [];
  if (cmdIn === null) errors.commands = "Commands must be a list of names.";
  else
    for (const c of cmdIn) {
      if (typeof c !== "string" || !COMMAND_RE.test(c.trim())) {
        errors.commands = `“${String(c)}” is not a command name (letters, numbers, dots, dashes, up to 60).`;
        break;
      }
      if (!commands.includes(c.trim())) commands.push(c.trim());
    }
  if (!errors.commands && tasks.includes("run") && commands.length === 0) errors.commands = "Name at least one command for the run task.";

  const ctIn = o.claudeTools === undefined || o.claudeTools === null ? [...DEFAULT_CLAUDE_TOOLS] : o.claudeTools;
  const claudeTools: string[] = [];
  if (!Array.isArray(ctIn) || ctIn.length === 0 || ctIn.length > 20) errors.claudeTools = "List 1 to 20 tool names, like Read or Bash(git log:*).";
  else
    for (const t of ctIn) {
      if (typeof t !== "string" || !CLAUDE_TOOL_RE.test(t.trim())) {
        errors.claudeTools = `“${String(t)}” is not a tool name (letters, numbers, spaces and : * ( ) . - only).`;
        break;
      }
      if (!claudeTools.includes(t.trim())) claudeTools.push(t.trim());
    }
  const cm = o.claudeMaxTurns === undefined || o.claudeMaxTurns === null ? DEFAULT_CLAUDE_MAX_TURNS : o.claudeMaxTurns;
  if (typeof cm !== "number" || !Number.isInteger(cm) || cm < 1 || cm > MAX_CLAUDE_TURNS) errors.claudeMaxTurns = `Use a whole number from 1 to ${MAX_CLAUDE_TURNS}.`;

  const cb = validateCallbackPrefixes(o.callbackUrls, urlOpts);
  if (!cb.ok) errors.callbackUrls = cb.error;

  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, contract: { name, folders, tasks, dailyLimit: dl as number, expires, approval, commands, claudeTools, claudeMaxTurns: cm as number, ...(cb.ok && cb.prefixes.length ? { callbackUrls: cb.prefixes } : {}) } };
}

/** The paths a job touches. echo touches none. */
export function jobPaths(job: Job): string[] | { error: string } {
  const a = job.args ?? {};
  if (job.task === "echo" || job.task === "run") return []; // run: the daemon checks the registered cwd itself
  const key = job.task === "claude" ? "cwd" : "path";
  const v = a[key];
  if (typeof v !== "string") return { error: `${job.task} needs a ${key}` };
  return [v];
}

/** The one rule: a parcel is allowed, waits for approval, or is refused with a reason. Never throws. */
export function check(contract: Contract, job: Job, ctx: CheckContext): Verdict {
  if (contract.expires && ctx.now >= Date.parse(contract.expires)) return { verdict: "refuse", reason: "contract expired" };
  if (typeof job?.task !== "string" || !contract.tasks.includes(job.task)) return { verdict: "refuse", reason: `task “${String(job?.task)}” is not in the contract` };
  if (ctx.usedToday >= contract.dailyLimit) return { verdict: "refuse", reason: `daily limit of ${contract.dailyLimit} reached` };

  if (job.task === "run") {
    const cmd = job.args?.command;
    if (typeof cmd !== "string" || !(contract.commands ?? []).includes(cmd)) return { verdict: "refuse", reason: `command “${String(cmd)}” is not in the contract` };
  }

  if (job.task === "claude") {
    const ceil = claudeCeiling(contract);
    const t = job.args?.allowedTools;
    if (t !== undefined) {
      const bad = Array.isArray(t) ? t.filter(x => typeof x !== "string" || !ceil.tools.includes(x)) : [t];
      if (bad.length) return { verdict: "refuse", reason: `claude tools ${bad.map(x => JSON.stringify(x)).join(", ")} are not in the contract (it allows: ${ceil.tools.join(", ")})` };
    }
    const m = job.args?.maxTurns;
    if (typeof m === "number" && m > ceil.maxTurns) return { verdict: "refuse", reason: `claude maxTurns ${m} is more than the contract allows (${ceil.maxTurns})` };
  }

  const paths = jobPaths(job);
  if (!Array.isArray(paths)) return { verdict: "refuse", reason: paths.error };
  const folders = contract.folders.map(f => normalizePath(f, ctx.home)).filter((f): f is string => f !== null);
  for (const p of paths) {
    const n = normalizePath(p, ctx.home);
    if (n === null) return { verdict: "refuse", reason: `path “${p}” must start with ~/ or / and stay inside its folder` };
    if (!folders.some(f => inside(n, f))) return { verdict: "refuse", reason: `${p} is outside the contract` };
  }
  return contract.approval.includes(job.task) ? { verdict: "approve" } : { verdict: "allow" };
}
