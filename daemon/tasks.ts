import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { check, normalizePath } from "../shared/contract.ts";
import type { Contract } from "../shared/contract.ts";
import { buildArgv, loadCommand } from "./commands.ts";

export type JobMsg = { id: string; task: string; args: Record<string, unknown>; contract: Contract };

export const MAX_BYTES = 200 * 1024;
const claudeTimeout = () => Number(process.env.MAILROOM_CLAUDE_TIMEOUT_MS) || 5 * 60 * 1000;

/** Expand ~, normalize, then realpath the deepest existing ancestor so symlinks cannot hide an escape. */
export function resolvePath(p: string, home: string): string | null {
  const n = normalizePath(p, home);
  if (n === null) return null;
  let existing = n;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync(existing);
      return path.join(real, ...tail.reverse());
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing) return n;
      tail.push(path.basename(existing));
      existing = parent;
    }
  }
}

/** Returns a refuse reason, or null if the job may run. Also returns the resolved path. */
export function recheck(job: JobMsg, now = Date.now(), home = os.homedir()): { reason: string } | { resolved: string | null } {
  const v = check(job.contract, { task: job.task, args: job.args ?? {} }, { now, usedToday: 0, home });
  if (v.verdict === "refuse") return { reason: v.reason };
  if (job.task === "echo") return { resolved: null };
  let raw = (job.task === "claude" ? job.args.cwd : job.args.path) as string;
  if (job.task === "run") {
    const c = loadCommand(job.args.command, home);
    if ("error" in c) return { reason: c.error };
    const b = buildArgv(c.command, job.args.args);
    if ("error" in b) return { reason: b.error };
    raw = c.command.cwd; // the laptop's registered cwd, not an arg
  }
  const real = resolvePath(raw, home);
  const folders = job.contract.folders.map(f => resolvePath(f, home));
  if (real === null || !folders.some(f => f !== null && (real === f || real.startsWith(f === "/" ? "/" : f + "/"))))
    return { reason: `${raw} resolves outside the contract folders` };
  return { resolved: real };
}

export async function runTask(job: JobMsg, resolved: string | null, signal: AbortSignal): Promise<unknown> {
  const a = job.args;
  switch (job.task) {
    case "echo":
      return { echo: a.text };
    case "read_file": {
      const st = fs.statSync(resolved!);
      if (!st.isFile()) throw new Error("not a file");
      if (st.size > MAX_BYTES) throw new Error(`file is bigger than ${MAX_BYTES / 1024} KB`);
      return { content: fs.readFileSync(resolved!, "utf8") };
    }
    case "write_file": {
      if (typeof a.content !== "string") throw new Error("write_file needs content");
      const bytes = Buffer.byteLength(a.content);
      if (bytes > MAX_BYTES) throw new Error(`content is bigger than ${MAX_BYTES / 1024} KB`);
      fs.mkdirSync(path.dirname(resolved!), { recursive: true }); // inside the allowed folder: recheck proved it
      const tmp = `${resolved}.${process.pid}.${Date.now()}.tmp`;
      try {
        fs.writeFileSync(tmp, a.content);
        fs.renameSync(tmp, resolved!);
      } finally {
        fs.rmSync(tmp, { force: true });
      }
      return { bytes };
    }
    case "claude":
      return { output: await runClaude(String(a.prompt ?? ""), resolved!, signal) };
    case "run":
      return runCommand(a, resolved!, signal);
    default:
      throw new Error(`unknown task ${job.task}`);
  }
}

function runClaude(prompt: string, cwd: string, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!prompt) return reject(new Error("claude needs a prompt"));
    const child = spawn("claude", ["-p", prompt], { cwd, stdio: ["ignore", "pipe", "pipe"], signal });
    let out = Buffer.alloc(0);
    let err = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, claudeTimeout());
    child.stdout.on("data", (d: Buffer) => {
      if (out.length < MAX_BYTES) out = Buffer.concat([out, d]).subarray(0, MAX_BYTES);
    });
    child.stderr.on("data", (d: Buffer) => {
      err = (err + d).slice(-2000);
    });
    child.on("error", e => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", code => {
      clearTimeout(timer);
      if (timedOut) reject(new Error("claude timed out"));
      else if (code !== 0) reject(new Error(`claude exited with ${code}: ${err.trim()}`));
      else resolve(out.toString("utf8"));
    });
  });
}

/** Starts a registered command: argv array, no shell, so metacharacters in args stay literal. */
function runCommand(a: Record<string, unknown>, cwd: string, signal: AbortSignal): Promise<{ output: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const c = loadCommand(a.command);
    if ("error" in c) return reject(new Error(c.error));
    const b = buildArgv(c.command, a.args);
    if ("error" in b) return reject(new Error(b.error));
    const child = spawn(c.command.script, b.argv, { cwd, stdio: ["ignore", "pipe", "pipe"], signal, shell: false });
    let out = Buffer.alloc(0);
    let err = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, c.command.timeoutMs);
    child.stdout.on("data", (d: Buffer) => {
      if (out.length < MAX_BYTES) out = Buffer.concat([out, d]).subarray(0, MAX_BYTES);
    });
    child.stderr.on("data", (d: Buffer) => {
      err = (err + d).slice(-2000);
    });
    child.on("error", e => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", code => {
      clearTimeout(timer);
      if (timedOut) reject(new Error(`${a.command} timed out`));
      else if (code !== 0) reject(new Error(`${a.command} exited with ${code}: ${err.trim()}`));
      else resolve({ output: out.toString("utf8"), exitCode: 0 });
    });
  });
}
