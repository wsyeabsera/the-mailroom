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

/** macOS only: hold the Mac awake while `child` runs, via `caffeinate -i -w <pid>` (argv, no shell).
 *  Skipped silently when caffeinate is missing. Returns a release function (safe to call twice). */
export function keepAwake(child: ChildProcess): () => void {
  if (process.platform !== "darwin" || child.pid === undefined) return () => {};
  let c: ChildProcess;
  try {
    c = spawn("caffeinate", ["-i", "-w", String(child.pid)], { stdio: "ignore" });
  } catch {
    return () => {};
  }
  c.on("error", () => {}); // ENOENT: no caffeinate, nothing to hold
  return () => { try { c.kill("SIGTERM"); } catch { /* gone */ } };
}

/** The distinct timeout error text shared by every task that runs a child. */
export const timeoutMessage = (ms: number) => `timed out after ${Math.max(1, Math.round(ms / 1000))}s`;
