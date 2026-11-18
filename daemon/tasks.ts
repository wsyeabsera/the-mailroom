import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseProgressLine } from "./progress.ts";
import { killTree, killTreeOnAbort, spawnTree, timeoutMessage } from "./proc.ts";
import { check, normalizePath } from "../shared/contract.ts";
import type { Contract } from "../shared/contract.ts";
import { buildArgv, loadCommand } from "./commands.ts";
import { loadPolicy, exceeds } from "./policy.ts";
import { MAX_RESULT_BYTES, MAX_WRITE_BYTES } from "../shared/limits.ts";

export type JobMsg = { id: string; task: string; args: Record<string, unknown>; contract: Contract };

export { MAX_RESULT_BYTES, MAX_WRITE_BYTES };
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
  // The laptop ceiling: whatever contract the Hub sent, it may not go beyond ~/.mailroom/policy.json (see policy.ts).
  const pol = loadPolicy(home);
  if ("error" in pol) return { reason: `laptop policy unusable: ${pol.error}` };
  const ceil = (r: string | null) => (pol.policy ? exceeds(pol.policy, job.contract, r, home) : null);
  if (job.task === "echo") {
    const over = ceil(null);
    return over ? { reason: over } : { resolved: null };
  }
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
  const over = ceil(real);
  if (over) return { reason: over };
  return { resolved: real };
}

export async function runTask(job: JobMsg, resolved: string | null, signal: AbortSignal, report: (text: string, pct?: number) => void = () => {}): Promise<unknown> {
  const a = job.args;
  switch (job.task) {
    case "echo":
      return { echo: a.text };
    case "read_file": {
      const st = fs.statSync(resolved!);
      if (!st.isFile()) throw new Error("not a file");
      if (st.size > MAX_RESULT_BYTES) throw new Error(`file is bigger than ${MAX_RESULT_BYTES / 1024 / 1024} MB`);
      return { content: fs.readFileSync(resolved!, "utf8") };
    }
    case "write_file": {
      if (typeof a.content !== "string") throw new Error("write_file needs content");
      const bytes = Buffer.byteLength(a.content);
      if (bytes > MAX_WRITE_BYTES) throw new Error(`content is bigger than ${MAX_WRITE_BYTES / 1024} KB`);
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
      return { output: await runClaude(String(a.prompt ?? ""), resolved!, signal, a) };
    case "run":
      return runCommand(a, resolved!, signal, report);
    default:
      throw new Error(`unknown task ${job.task}`);
  }
}

function claudeOptions(a: Record<string, unknown>): { argv: string[]; json: boolean } {
  const argv: string[] = [];
  if (a.allowedTools !== undefined) {
    const t = a.allowedTools;
    if (!Array.isArray(t) || t.length < 1 || t.length > 20) throw new Error("allowedTools must be an array of 1 to 20 strings");
    for (const x of t) if (typeof x !== "string" || !/^[\w:*() .\-]{1,100}$/.test(x)) throw new Error(`allowedTools has an invalid entry: ${JSON.stringify(x)}`);
    argv.push("--allowedTools", ...(t as string[]));
  }
  if (a.maxTurns !== undefined) {
    if (typeof a.maxTurns !== "number" || !Number.isInteger(a.maxTurns) || a.maxTurns < 1 || a.maxTurns > 50) throw new Error("maxTurns must be an integer from 1 to 50");
    argv.push("--max-turns", String(a.maxTurns));
  }
  if (a.model !== undefined) {
    if (typeof a.model !== "string" || !/^[\w.\-\[\]]{1,60}$/.test(a.model)) throw new Error("model has invalid characters or length");
    argv.push("--model", a.model);
  }
  if (a.json !== undefined && typeof a.json !== "boolean") throw new Error("json must be true or false");
  if (a.json) argv.push("--output-format", "json");
  return { argv, json: a.json === true };
}

function runClaude(prompt: string, cwd: string, signal: AbortSignal, args: Record<string, unknown> = {}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!prompt) return reject(new Error("claude needs a prompt"));
    let opts: { argv: string[]; json: boolean };
    try {
      opts = claudeOptions(args);
    } catch (e) {
      return reject(e);
    }
    // options go before the prompt; "--" is not used because --allowedTools is variadic
    const child = spawnTree("claude", [...opts.argv, "-p", prompt], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const unhook = killTreeOnAbort(child, signal);
    let out = Buffer.alloc(0);
    let err = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, claudeTimeout());
    child.stdout!.on("data", (d: Buffer) => {
      if (out.length < MAX_RESULT_BYTES) out = Buffer.concat([out, d]).subarray(0, MAX_RESULT_BYTES);
    });
    child.stderr!.on("data", (d: Buffer) => {
      err = (err + d).slice(-2000);
    });
    child.on("error", e => {
      clearTimeout(timer);
      unhook();
      reject(e);
    });
    child.on("close", code => {
      clearTimeout(timer);
      unhook();
      if (timedOut) reject(new Error(timeoutMessage(claudeTimeout())));
      else if (code !== 0) reject(new Error(`claude exited with ${code}: ${err.trim()}`));
      else if (opts.json) {
        try {
          resolve(JSON.parse(out.toString("utf8")));
        } catch {
          reject(new Error("claude did not return valid JSON (output may be truncated)"));
        }
      } else resolve(out.toString("utf8"));
    });
  });
}

/** Starts a registered command: argv array, no shell, so metacharacters in args stay literal. */
function runCommand(a: Record<string, unknown>, cwd: string, signal: AbortSignal, report: (text: string, pct?: number) => void): Promise<{ output: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const c = loadCommand(a.command);
    if ("error" in c) return reject(new Error(c.error));
    const b = buildArgv(c.command, a.args);
    if ("error" in b) return reject(new Error(b.error));
    const child = spawnTree(c.command.script, b.argv, { cwd, stdio: ["ignore", "pipe", "pipe"], shell: false });
    const unhook = killTreeOnAbort(child, signal);
    let out = Buffer.alloc(0);
    let err = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, c.command.timeoutMs);
    child.stdout!.on("data", (d: Buffer) => {
      if (out.length < MAX_RESULT_BYTES) out = Buffer.concat([out, d]).subarray(0, MAX_RESULT_BYTES);
    });
    let pending = ""; // stderr arrives in chunks; a progress line may be split across them
    child.stderr!.on("data", (d: Buffer) => {
      err = (err + d).slice(-2000);
      const lines = (pending + d).split("\n");
      pending = lines.pop()!.slice(-1000);
      for (const l of lines) {
        const p = parseProgressLine(l);
        if (p) report(p.text, p.pct);
      }
    });
    child.on("error", e => {
      clearTimeout(timer);
      unhook();
      reject(e);
    });
    child.on("close", code => {
      clearTimeout(timer);
      unhook();
      if (timedOut) reject(new Error(timeoutMessage(c.command.timeoutMs)));
      else if (code !== 0) reject(new Error(`${a.command} exited with ${code}: ${err.trim()}`));
      else resolve({ output: out.toString("utf8"), exitCode: 0 });
    });
  });
}
