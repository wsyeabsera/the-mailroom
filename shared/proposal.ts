// Contract change proposals: the plain-words diff between a contract and a proposed replacement, and which changes widen it.
// Pure: no I/O. A proposal is only ever stored; the owner applies it (src/hub.ts), and applying re-validates with validateContract.

import { DEFAULT_CLAUDE_DAILY_MINUTES, DEFAULT_CLAUDE_DAILY_TURNS } from "./claude-budget.ts";
import { DEFAULT_CLAUDE_MAX_TURNS, DEFAULT_CLAUDE_TOOLS, inside, normalizePath, type Contract } from "./contract.ts";

export type Change = { field: string; text: string; widening: boolean };

/** Tasks that can write to the laptop or start Claude: adding one always counts as widening. */
export const RISKY_TASKS: readonly string[] = ["write_file", "claude"];

/** The fields a proposal may change. `name` is allowed, never a widening. */
export const PROPOSABLE_FIELDS = ["name", "folders", "tasks", "approval", "dailyLimit", "expires", "commands", "prompts", "claudeTools", "claudeMaxTurns", "claudeDailyTurns", "claudeDailyMinutes", "callbackUrls"] as const;

const added = (a: string[], b: string[]) => b.filter((x) => !a.includes(x));
const list = (xs: string[]) => xs.map((x) => `“${x}”`).join(", ");

/** Every difference between two validated contracts, in plain words, each flagged when it widens what a key may do. */
export function diffContracts(cur: Contract, next: Contract): Change[] {
  const out: Change[] = [];
  const push = (field: string, text: string, widening = false) => out.push({ field, text, widening });
  const setDiff = (field: string, label: string, a: string[], b: string[], widenOnAdd: (x: string) => boolean) => {
    const plus = added(a, b), minus = added(b, a);
    if (plus.length) push(field, `Adds ${label} ${list(plus)}.`, plus.some(widenOnAdd));
    if (minus.length) push(field, `Removes ${label} ${list(minus)}.`);
  };

  if (cur.name !== next.name) push("name", `Renames the contract from “${cur.name}” to “${next.name}”.`);

  const curFolders = cur.folders.map((f) => normalizePath(f) ?? f);
  const newFolders = next.folders.map((f) => normalizePath(f) ?? f);
  const plusF = added(curFolders, newFolders), minusF = added(newFolders, curFolders);
  if (plusF.length) push("folders", `Adds ${plusF.length === 1 ? "folder" : "folders"} ${list(plusF)}.`, plusF.some((f) => !curFolders.some((c) => inside(f, c))));
  if (minusF.length) push("folders", `Removes ${minusF.length === 1 ? "folder" : "folders"} ${list(minusF)}.`);

  setDiff("tasks", "the task", cur.tasks, next.tasks, (t) => RISKY_TASKS.includes(t));
  const noLongerAsked = added(next.approval, cur.approval).filter((t) => next.tasks.includes(t));
  if (noLongerAsked.length) push("approval", `The owner will no longer be asked first for ${list(noLongerAsked)}.`, true);
  const nowAsked = added(cur.approval, next.approval);
  if (nowAsked.length) push("approval", `The owner will be asked first for ${list(nowAsked)}.`);

  const num = (field: string, label: string, a: number, b: number) => {
    if (a !== b) push(field, `${b > a ? "Raises" : "Lowers"} ${label} from ${a} to ${b}.`, b > a);
  };
  num("dailyLimit", "the daily parcel limit", cur.dailyLimit, next.dailyLimit);
  num("claudeMaxTurns", "the most turns a claude job may take", cur.claudeMaxTurns ?? DEFAULT_CLAUDE_MAX_TURNS, next.claudeMaxTurns ?? DEFAULT_CLAUDE_MAX_TURNS);
  num("claudeDailyTurns", "the daily Claude budget in turns", cur.claudeDailyTurns ?? DEFAULT_CLAUDE_DAILY_TURNS, next.claudeDailyTurns ?? DEFAULT_CLAUDE_DAILY_TURNS);
  num("claudeDailyMinutes", "the daily Claude budget in minutes", cur.claudeDailyMinutes ?? DEFAULT_CLAUDE_DAILY_MINUTES, next.claudeDailyMinutes ?? DEFAULT_CLAUDE_DAILY_MINUTES);

  if ((cur.expires ?? null) !== (next.expires ?? null)) {
    const later = next.expires === null || (cur.expires !== null && Date.parse(next.expires) > Date.parse(cur.expires));
    push("expires", next.expires === null ? "The contract will never expire." : `The contract will expire on ${next.expires.slice(0, 10)}.`, later);
  }

  setDiff("commands", "the command", cur.commands ?? [], next.commands ?? [], () => false);
  setDiff("prompts", "the prompt", cur.prompts ?? [], next.prompts ?? [], () => false);
  setDiff("claudeTools", "the Claude tool", cur.claudeTools ?? [...DEFAULT_CLAUDE_TOOLS], next.claudeTools ?? [...DEFAULT_CLAUDE_TOOLS], () => true);
  setDiff("callbackUrls", "the callback address", cur.callbackUrls ?? [], next.callbackUrls ?? [], () => true);
  return out;
}

export const isWidening = (changes: Change[]): boolean => changes.some((c) => c.widening);
