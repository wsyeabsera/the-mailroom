import { spawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";

/** Spawn as the leader of a new process group, so the whole tree can be killed at once with killTree. */
export function spawnTree(cmd: string, args: string[], opts: SpawnOptions = {}): ChildProcess {
  return spawn(cmd, args, { ...opts, detached: true });
}

/** Kill a child and everything it started: SIGKILL to the process group (the child must have been spawned detached).
 *  Falls back to the child alone if the group is already gone. Safe to call twice. */
export function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try { child.kill("SIGKILL"); } catch { /* already dead */ }
  }
}

/** Kill the tree when the signal aborts (cancel or lost connection). Returns an unhook function. */
export function killTreeOnAbort(child: ChildProcess, signal: AbortSignal): () => void {
  if (signal.aborted) { killTree(child); return () => {}; }
  const f = () => killTree(child);
  signal.addEventListener("abort", f, { once: true });
  return () => signal.removeEventListener("abort", f);
}

/** The distinct timeout error text shared by every task that runs a child. */
export const timeoutMessage = (ms: number) => `timed out after ${Math.max(1, Math.round(ms / 1000))}s`;
