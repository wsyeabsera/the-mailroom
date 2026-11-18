// The laptop-side ceiling: ~/.mailroom/policy.json lists the folders, tasks and (optionally) command names the daemon will
// never go beyond, whatever contract the Hub sends. Loaded fresh for every job, so an edit applies to the next job.
// Missing file => no ceiling (the Hub's contract is checked as before) and one warning per process.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolvePathFor } from "./paths.ts";

export type Policy = { folders: string[]; tasks: string[]; commands?: string[] };
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
    if (!p || typeof p !== "object" || !strs(p.folders) || !strs(p.tasks) || (p.commands !== undefined && !strs(p.commands)))
      return { error: `${policyPath(home)} must look like {"folders":[],"tasks":[],"commands":[]}` };
    return { policy: { folders: p.folders, tasks: p.tasks, ...(p.commands ? { commands: p.commands } : {}) } };
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

/** Returns a refuse reason if the contract (or the resolved job path) goes beyond the policy, else null. */
export function exceeds(
  policy: Policy,
  contract: { folders: string[]; tasks: string[]; commands?: string[] },
  realPath: string | null,
  home: string,
): string | null {
  const pf = policy.folders.map(f => resolvePathFor(f, home));
  for (const f of contract.folders) {
    const r = resolvePathFor(f, home);
    if (r === null || !pf.some(p => p !== null && within(r, p))) return `contract folder ${f} is outside the laptop policy folders`;
  }
  const extra = contract.tasks.filter(t => !policy.tasks.includes(t));
  if (extra.length) return `contract tasks ${extra.join(", ")} are not allowed by the laptop policy`;
  if (Array.isArray(contract.commands)) {
    const allowed = policy.commands ?? [];
    const bad = contract.commands.filter(c => !allowed.includes(c));
    if (bad.length) return `contract commands ${bad.join(", ")} are not allowed by the laptop policy`;
  }
  if (realPath !== null && !pf.some(p => p !== null && within(realPath, p))) return `${realPath} is outside the laptop policy folders`;
  return null;
}
