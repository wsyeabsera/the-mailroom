// Owner-only debug log of Claude jobs: ~/.mailroom/logs/<job id>.txt (dir 0700, file 0600). It holds what Claude said (the raw reply and the turns),
// which the Hub never gets: when a job fails the Hub only has a character count. Never sent anywhere; read with `mailroom logs <job id>`.
// Files older than 7 days are deleted when the daemon starts. The policy switch `logs: false` turns writing off.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { JOB_ID_RE } from "../shared/contract.ts";

export const LOG_TTL_MS = 7 * 24 * 3600_000;
const MAX_LOG_BYTES = 1024 * 1024;

export const logsDir = (home = os.homedir()) => path.join(home, ".mailroom", "logs");
const fileFor = (jobId: string, home: string) => path.join(logsDir(home), `${jobId}.txt`);

/** Appends one Claude run to the job's log. Never throws: a debug log must not fail a job. */
export function writeLog(jobId: string, run: { label: string; turns: string[]; reply: string; error?: string }, home = os.homedir(), now = new Date()): void {
  try {
    if (!JOB_ID_RE.test(jobId)) return;
    fs.mkdirSync(logsDir(home), { recursive: true, mode: 0o700 });
    const body = [
      `=== ${run.label} at ${now.toISOString()} ===`,
      `turns:`,
      ...(run.turns.length ? run.turns.map(t => `  ${t}`) : ["  (none seen)"]),
      ...(run.error ? [`error: ${run.error}`] : []),
      `reply:`,
      run.reply.length > MAX_LOG_BYTES ? run.reply.slice(0, MAX_LOG_BYTES) + "\n[cut]" : run.reply,
      "",
    ].join("\n");
    const file = fileFor(jobId, home);
    fs.appendFileSync(file, body + "\n", { mode: 0o600 });
    fs.chmodSync(file, 0o600);
  } catch {
    /* ignore */
  }
}

/** The log text for a job, or an error naming why there is none. */
export function readLog(jobId: string, home = os.homedir()): { text: string } | { error: string } {
  if (!JOB_ID_RE.test(jobId)) return { error: "that is not a job id" };
  try {
    return { text: fs.readFileSync(fileFor(jobId, home), "utf8") };
  } catch {
    return { error: `no log for ${jobId} on this laptop (logs are kept 7 days, only for claude and ask jobs, and not when the policy sets logs to false)` };
  }
}

/** Deletes log files older than the TTL. Returns how many. Never throws. */
export function purgeLogs(home = os.homedir(), now = Date.now()): number {
  let n = 0;
  try {
    for (const f of fs.readdirSync(logsDir(home))) {
      const p = path.join(logsDir(home), f);
      try {
        if (now - fs.statSync(p).mtimeMs > LOG_TTL_MS) { fs.rmSync(p, { force: true }); n++; }
      } catch { /* skip */ }
    }
  } catch { /* no logs yet */ }
  return n;
}
