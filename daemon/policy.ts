// The laptop-side ceiling: ~/.mailroom/policy.json lists the folders, tasks and (optionally) command names the daemon will
// never go beyond, whatever contract the Hub sends. Loaded fresh for every job, so an edit applies to the next job.
// Missing file => no ceiling (the Hub's contract is checked as before) and one warning per process.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolvePathFor } from "./paths.ts";
import { claudeCeiling, DEFAULT_CLAUDE_MAX_TURNS, DEFAULT_CLAUDE_TOOLS } from "../shared/contract.ts";

export type Policy = { folders: string[]; tasks: string[]; commands?: string[]; prompts?: string[]; claudeTools?: string[]; claudeMaxTurns?: number; logs?: boolean };
export type PolicyLoad = { policy: Policy | null } | { error: string };

export const policyPath = (home = os.homedir()) => path.join(home, ".mailroom", "policy.json");

let warned = false;
export function resetPolicyWarning() { warned = false; }

const strs = (v: unknown) => Array.isArray(v) && v.every(x => typeof x === "string");

/** Reads the policy. policy null = no file. A file that exists but is unreadable or malformed is an error (the daemon fails closed). */
export function loadPolicy(home = os.homedir()): PolicyLoad {
  let text: string;
  try {
    text = fs.readFileSync(policyPath(home), "utf8");
  } catch (e: any) {
    if (e?.code === "ENOENT") {
      if (!warned) {
        warned = true;
        console.warn(`warning: no laptop policy at ${policyPath(home)}: the daemon trusts the contract the Hub sends. Run \`mailroom policy allow-folder <path>\` to set a ceiling.`);
      }
      return { policy: null };
    }
    return { error: `cannot read ${policyPath(home)}: ${e?.message}` };
  }
  try {
    const p = JSON.parse(text);
    if (!p || typeof p !== "object" || !strs(p.folders) || !strs(p.tasks) || (p.commands !== undefined && !strs(p.commands)) || (p.prompts !== undefined && !strs(p.prompts)) || (p.claudeTools !== undefined && !strs(p.claudeTools)) || (p.claudeMaxTurns !== undefined && !(Number.isInteger(p.claudeMaxTurns) && p.claudeMaxTurns >= 1)) || (p.logs !== undefined && typeof p.logs !== "boolean"))
      return { error: `${policyPath(home)} must look like {"folders":[],"tasks":[],"commands":[],"claudeTools":[],"claudeMaxTurns":10}` };
    return { policy: { folders: p.folders, tasks: p.tasks, ...(p.commands ? { commands: p.commands } : {}), ...(p.prompts ? { prompts: p.prompts } : {}), ...(p.claudeTools ? { claudeTools: p.claudeTools } : {}), ...(p.claudeMaxTurns !== undefined ? { claudeMaxTurns: p.claudeMaxTurns } : {}), ...(p.logs !== undefined ? { logs: p.logs } : {}) } };
  } catch {
    return { error: `${policyPath(home)} is not valid JSON` };
  }
}

export function savePolicy(p: Policy, home = os.homedir()) {
  const file = policyPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(p, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
}

const within = (real: string, f: string) => real === f || real.startsWith(f === "/" ? "/" : f + "/");

/** The claude ceilings a policy grants: the safe defaults when the policy does not set them. */
export const policyClaude = (p: Policy) => ({ tools: p.claudeTools ?? [...DEFAULT_CLAUDE_TOOLS], maxTurns: p.claudeMaxTurns ?? DEFAULT_CLAUDE_MAX_TURNS });

/** Returns a refuse reason if the contract (or the resolved job path) goes beyond the policy, else null. Each reason names the fix. */
export function exceeds(
  policy: Policy,
  contract: { folders: string[]; tasks: string[]; commands?: string[]; prompts?: string[]; claudeTools?: string[]; claudeMaxTurns?: number },
  realPath: string | null,
  home: string,
): string | null {
  const pf = policy.folders.map(f => resolvePathFor(f, home));
  for (const f of contract.folders) {
    const r = resolvePathFor(f, home);
    if (r === null || !pf.some(p => p !== null && within(r, p))) return `contract folder ${f} is outside the laptop policy folders. To allow it: mailroom policy allow-folder ${f}`;
  }
  const extra = contract.tasks.filter(t => !policy.tasks.includes(t));
  if (extra.length) return `contract tasks ${extra.join(", ")} are not allowed by the laptop policy. To allow: ${extra.map(t => `mailroom policy allow-task ${t}`).join("; ")}`;
  if (Array.isArray(contract.commands)) {
    const allowed = policy.commands ?? [];
    const bad = contract.commands.filter(c => !allowed.includes(c));
    if (bad.length) return `contract commands ${bad.join(", ")} are not allowed by the laptop policy. To allow: ${bad.map(c => `mailroom policy allow-command ${c}`).join("; ")}`;
  }
  if (Array.isArray(contract.prompts)) {
    const allowed = policy.prompts ?? [];
    const bad = contract.prompts.filter(c => !allowed.includes(c));
    if (bad.length) return `contract prompts ${bad.join(", ")} are not allowed by the laptop policy. To allow: ${bad.map(c => `mailroom policy allow-prompt ${c}`).join("; ")}`;
  }
  if (contract.tasks.includes("claude") || contract.tasks.includes("ask")) {
    const c = claudeCeiling(contract);
    const pc = policyClaude(policy);
    const badTools = c.tools.filter(t => !pc.tools.includes(t));
    if (badTools.length) return `contract claude tools ${badTools.join(", ")} are not allowed by the laptop policy. To allow: ${badTools.map(t => `mailroom policy allow-claude-tool '${t}'`).join("; ")}`;
    if (c.maxTurns > pc.maxTurns) return `contract claude maxTurns ${c.maxTurns} is more than the laptop policy allows (${pc.maxTurns}). To allow: mailroom policy claude-max-turns ${c.maxTurns}`;
  }
  if (realPath !== null && !pf.some(p => p !== null && within(realPath, p))) return `${realPath} is outside the laptop policy folders. To allow it: mailroom policy allow-folder ${realPath}`;
  return null;
}
