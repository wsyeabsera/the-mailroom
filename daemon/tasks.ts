import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseProgressLine } from "./progress.ts";
import { parsePartialLine } from "../shared/partials.ts";
import { keepAwake, killTree, killTreeOnAbort, spawnTree, timeoutMessage } from "./proc.ts";
import { READ_ONLY_TOOLS, StreamReader, makeScratch, removeScratch } from "./claude.ts";
import { check, normalizePath, claudeCeiling } from "../shared/contract.ts";
import type { Contract } from "../shared/contract.ts";
import { buildArgv, loadCommand } from "./commands.ts";
import { clipTimeoutMs, type Usage } from "../shared/claude-budget.ts";
import { findResume, recordSession, scratchRoot, type SessionEntry } from "./sessions.ts";
import { parseAnswer } from "../shared/json-schema.ts";
import { fillTemplate, loadPrompt, type Prompt } from "./prompts.ts";
import { loadPolicy, exceeds } from "./policy.ts";
import { MAX_RESULT_BYTES, MAX_WRITE_BYTES } from "../shared/limits.ts";
import { runBatch, runWorkflow } from "./pipeline.ts";
import { loadWorkflow } from "./workflows.ts";
import { batchTarget } from "../shared/pipeline.ts";

export type JobMsg = { id: string; task: string; args: Record<string, unknown>; contract: Contract; budget?: { turns: number; ms: number } /* what is left of the key's claude day; from the Hub */ };

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
export function recheck(job: JobMsg, now = Date.now(), home = os.homedir(), implicit: string[] = []): { reason: string } | { resolved: string | null } {
  // `implicit`: a batch item or workflow step is checked as the single job it is (run, ask or batch) without the contract having to list that task.
  const v = check(implicit.length ? { ...job.contract, tasks: [...new Set([...job.contract.tasks, ...implicit])] } : job.contract, { task: job.task, args: job.args ?? {} }, { now, usedToday: 0, home });
  if (v.verdict === "refuse") return { reason: v.reason };
  // The laptop ceiling: whatever contract the Hub sent, it may not go beyond ~/.mailroom/policy.json (see policy.ts).
  const pol = loadPolicy(home);
  if ("error" in pol) return { reason: `laptop policy unusable: ${pol.error}` };
  const ceil = (r: string | null) => (pol.policy ? exceeds(pol.policy, job.contract, r, home, implicit) : null);
  if (job.task === "echo") {
    const over = ceil(null);
    return over ? { reason: over } : { resolved: null };
  }
  if (job.task === "batch" || job.task === "workflow") {
    const why = job.task === "batch" ? batchRefusal(job, home) : workflowRefusal(job, home, implicit);
    if (why) return { reason: why };
    const over = ceil(null);
    return over ? { reason: over } : { resolved: null };
  }
  let raw = (job.task === "claude" ? job.args.cwd : job.args.path) as string;
  if ((job.task === "claude" || job.task === "ask") && job.args.resume !== undefined) {
    const s = findResume(job.args.resume, job.task, job.task === "ask" ? (job.args.prompt as string) : undefined, home, now);
    if ("error" in s) return { reason: s.error };
  }
  if (job.task === "ask") {
    const name = job.args.prompt as string;
    if (pol.policy && !(pol.policy.prompts ?? []).includes(name)) return { reason: `prompt “${name}” is not allowed by the laptop policy. To allow: mailroom policy allow-prompt ${name}` };
    const p = loadPrompt(name, home);
    if ("error" in p) return { reason: p.error };
    const f = fillTemplate(p.prompt, job.args.vars);
    if ("error" in f) return { reason: f.error };
    raw = p.prompt.cwd; // the laptop's registered cwd, not an arg
  }
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

export async function runTask(job: JobMsg, resolved: string | null, signal: AbortSignal, report: (text: string, pct?: number) => void = () => {}, onUsage: (u: Usage) => void = () => {}, onPartial: (value: unknown) => void = () => {}, extra: { stdin?: string } = {}): Promise<unknown> {
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
      return { output: await runClaude(String(a.prompt ?? ""), resolved!, signal, a, claudeCeiling(job.contract), report, job.id, onUsage, job.budget) };
    case "ask":
      return runAsk(job, resolved!, signal, report, onUsage);
    case "run":
      return runCommand(a, resolved!, signal, report, onPartial, extra.stdin);
    case "batch":
      return runBatch(job, signal, report, onUsage, onPartial);
    case "workflow":
      return runWorkflow(job, signal, report, onUsage, onPartial);
    default:
      throw new Error(`unknown task ${job.task}`);
  }
}

function claudeOptions(a: Record<string, unknown>, ceil: { tools: string[]; maxTurns: number }): { argv: string[]; json: boolean; scratch: boolean } {
  const argv: string[] = [];
  // Re-checked here so the daemon holds even if recheck were skipped; no option = the contract's defaults, never the CLI's.
  if (a.allowedTools === undefined) {
    // scratch default is read-only tools, clipped by the ceiling so a scratch job never gets more than the contract allows
    const def = a.scratch === true ? READ_ONLY_TOOLS.filter(x => ceil.tools.includes(x)) : ceil.tools;
    if (!def.length) throw new Error("scratch needs a read-only tool (Read, Grep or Glob) in the contract's claudeTools");
    argv.push("--allowedTools", ...def);
  }
  else {
    const t = a.allowedTools;
    if (!Array.isArray(t) || t.length < 1 || t.length > 20) throw new Error("allowedTools must be an array of 1 to 20 strings");
    for (const x of t) if (typeof x !== "string" || !/^[\w:*() .\-]{1,100}$/.test(x)) throw new Error(`allowedTools has an invalid entry: ${JSON.stringify(x)}`);
    const over = (t as string[]).filter(x => !ceil.tools.includes(x));
    if (over.length) throw new Error(`allowedTools ${over.join(", ")} not allowed by the contract`);
    argv.push("--allowedTools", ...(t as string[]));
  }
  if (a.maxTurns === undefined) argv.push("--max-turns", String(ceil.maxTurns));
  else {
    if (typeof a.maxTurns !== "number" || !Number.isInteger(a.maxTurns) || a.maxTurns < 1 || a.maxTurns > 50) throw new Error("maxTurns must be an integer from 1 to 50");
    if (a.maxTurns > ceil.maxTurns) throw new Error(`maxTurns ${a.maxTurns} is more than the contract allows (${ceil.maxTurns})`);
    argv.push("--max-turns", String(a.maxTurns));
  }
  if (a.model !== undefined) {
    if (typeof a.model !== "string" || !/^[\w.\-\[\]]{1,60}$/.test(a.model)) throw new Error("model has invalid characters or length");
    argv.push("--model", a.model);
  }
  if (a.json !== undefined && typeof a.json !== "boolean") throw new Error("json must be true or false");
  if (a.scratch !== undefined && typeof a.scratch !== "boolean") throw new Error("scratch must be true or false");
  // --output-format is added by runClaude (always stream-json internally; json:true returns the final result object)
  return { argv, json: a.json === true, scratch: a.scratch === true };
}

/** The `ask` task: the laptop's registered prompt, filled with checked variables, run with the prompt's own tools, turns, model and timeout.
 *  The contract's claude ceilings still clip tools (intersection) and turns (minimum); the client supplies only variables. */
async function runAsk(job: JobMsg, cwd: string, signal: AbortSignal, report: (text: string) => void, onUsage: (u: Usage) => void = () => {}): Promise<unknown> {
  const a = job.args;
  const p = loadPrompt(a.prompt);
  if ("error" in p) throw new Error(p.error);
  const f = fillTemplate(p.prompt, a.vars);
  if ("error" in f) throw new Error(f.error);
  const opts = askOptions(p.prompt, claudeCeiling(job.contract));
  const r = await execClaude(f.text, cwd, signal, opts, p.prompt.timeoutMs, report, { id: job.id, task: "ask", prompt: String(a.prompt), resume: a.resume }, onUsage, job.budget);
  const text = typeof r.result?.result === "string" ? r.result.result : r.raw;
  // A prompt with a schema never returns a result that does not match it: the answer is parsed and validated, and the parsed value is the output.
  if (p.prompt.schema) {
    const parsed = parseAnswer(p.prompt.schema, text);
    if (!parsed.ok) throw new Error(parsed.error);
    return { output: parsed.value };
  }
  return { output: Buffer.from(text).subarray(0, MAX_RESULT_BYTES).toString("utf8") };
}

/** Builds claude's options from a registered prompt, clipped by the contract ceiling. Throws when nothing is left to run with. */
export function askOptions(p: Prompt, ceil: { tools: string[]; maxTurns: number }): { argv: string[]; scratch: boolean } {
  const tools = p.tools.filter(t => ceil.tools.includes(t));
  if (!tools.length) throw new Error(`none of the prompt's tools (${p.tools.join(", ")}) are allowed by the contract (it allows: ${ceil.tools.join(", ")})`);
  const argv = ["--allowedTools", ...tools, "--max-turns", String(Math.min(p.maxTurns, ceil.maxTurns))];
  if (p.model) argv.push("--model", p.model);
  return { argv, scratch: p.scratch };
}

async function runClaude(prompt: string, cwd: string, signal: AbortSignal, args: Record<string, unknown> = {}, ceil = claudeCeiling({}), report: (text: string) => void = () => {}, jobId = "job", onUsage: (u: Usage) => void = () => {}, budget?: { turns: number; ms: number }): Promise<unknown> {
  if (!prompt) throw new Error("claude needs a prompt");
  const opts = claudeOptions(args, ceil);
  const r = await execClaude(prompt, cwd, signal, opts, claudeTimeout(), report, { id: jobId, task: "claude", resume: args.resume }, onUsage, budget);
  if (opts.json) {
    if (r.result) return r.result;
    throw new Error("claude did not return valid JSON (output may be truncated)");
  }
  if (r.result && typeof r.result.result === "string") return Buffer.from(r.result.result + "\n").subarray(0, MAX_RESULT_BYTES).toString("utf8");
  return r.raw;
}

type ExecResult = { result: Record<string, unknown> | null; raw: string };

/** Starts claude with the given options and waits: stream-json progress through `report`, the final result event, timeout, cancel, scratch cleanup. */
function execClaude(prompt: string, cwd: string, signal: AbortSignal, opts: { argv: string[]; scratch: boolean }, timeoutMs: number, report: (text: string) => void, who: { id: string; task: "ask" | "claude"; prompt?: string; resume?: unknown }, onUsage: (u: Usage) => void = () => {}, budget?: { turns: number; ms: number }): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    let runCwd = cwd;
    let scratchDir: string | null = null;
    const argv = [...opts.argv];
    // The key's remaining claude turns clip --max-turns (never below 1; the Hub refuses a key with none left). Applies to claude and ask alike.
    if (budget && Number.isFinite(budget.turns)) {
      const i = argv.indexOf("--max-turns");
      if (i >= 0) argv[i + 1] = String(Math.max(1, Math.min(Number(argv[i + 1]), Math.floor(budget.turns))));
    }
    // Resume: claude finds a session by its working folder, so a resumed scratch job runs in the same scratch path as the one it continues.
    let resumed: SessionEntry | null = null;
    if (who.resume !== undefined) {
      const s = findResume(who.resume, who.task, who.prompt);
      if ("error" in s) return reject(new Error(s.error));
      resumed = s.session;
      argv.push("--resume", resumed.sessionId);
    }
    if (opts.scratch) {
      // Research mode: Claude works in a throwaway folder; the contract folder is only added as an extra directory (see docs/api.md for what this does not enforce).
      try {
        const again = resumed && path.dirname(resumed.cwd) === scratchRoot() ? resumed.cwd : null;
        if (again) fs.mkdirSync(again, { recursive: true, mode: 0o700 });
        scratchDir = again ?? makeScratch(who.id);
      } catch (e) {
        return reject(e);
      }
      runCwd = scratchDir;
      argv.push("--add-dir", cwd);
    }
    argv.push("--output-format", "stream-json", "--verbose");
    // options go before the prompt; "--" is not used because --allowedTools is variadic
    let child;
    try {
      child = spawnTree("claude", [...argv, "-p", prompt], { cwd: runCwd, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      if (scratchDir) removeScratch(scratchDir);
      return reject(e);
    }
    const startedAt = Date.now();
    const limitMs = clipTimeoutMs(timeoutMs, budget?.ms); // the usual timeout, or what is left of the key's daily minutes
    const unhook = killTreeOnAbort(child, signal);
    const release = keepAwake(child);
    let last = "";
    const stream = new StreamReader(text => { if (text !== last) { last = text; report(text); } });
    let err = "";
    let raw = Buffer.alloc(0); // non-stream fallback (a claude that ignored stream-json)
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, limitMs);
    const cleanup = () => {
      clearTimeout(timer);
      unhook();
      release();
      if (scratchDir) removeScratch(scratchDir);
    };
    child.stdout!.on("data", (d: Buffer) => {
      stream.push(d);
      if (raw.length < MAX_RESULT_BYTES) raw = Buffer.concat([raw, d]).subarray(0, MAX_RESULT_BYTES);
    });
    child.stderr!.on("data", (d: Buffer) => {
      err = (err + d).slice(-2000);
    });
    child.on("error", e => {
      cleanup();
      reject(e);
    });
    child.on("close", code => {
      cleanup();
      stream.end();
      // Usage for the Hub's daily budget: turns from the result event (else the assistant turns seen), and wall time. Reported on every outcome.
      const nt = stream.result?.num_turns;
      onUsage({ turns: typeof nt === "number" && Number.isFinite(nt) ? nt : stream.turn, ms: Date.now() - startedAt });
      if (timedOut) return reject(new Error(timeoutMessage(limitMs)));
      if (code !== 0) return reject(new Error(`claude exited with ${code}: ${err.trim()}`));
      const sid = stream.result?.session_id;
      if (typeof sid === "string") recordSession(who.id, { sessionId: sid, task: who.task, ...(who.prompt !== undefined ? { prompt: who.prompt } : {}), cwd: runCwd });
      resolve({ result: stream.result, raw: raw.toString("utf8") });
    });
  });
}

/** Starts a registered command: argv array, no shell, so metacharacters in args stay literal. */
function runCommand(a: Record<string, unknown>, cwd: string, signal: AbortSignal, report: (text: string, pct?: number) => void, onPartial: (value: unknown) => void = () => {}, stdin?: string): Promise<{ output: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const c = loadCommand(a.command);
    if ("error" in c) return reject(new Error(c.error));
    const b = buildArgv(c.command, a.args);
    if ("error" in b) return reject(new Error(b.error));
    const child = spawnTree(c.command.script, b.argv, { cwd, stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"], shell: false });
    if (stdin !== undefined) {
      // A workflow step may hand earlier output to the script on standard input (args are too short for data). A script that never reads it is fine.
      child.stdin!.on("error", () => {});
      child.stdin!.end(Buffer.from(stdin).subarray(0, MAX_RESULT_BYTES));
    }
    const unhook = killTreeOnAbort(child, signal);
    const release = keepAwake(child);
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
        else {
          const q = parsePartialLine(l);
          if (q) onPartial(q.value);
        }
      }
    });
    child.on("error", e => {
      clearTimeout(timer);
      unhook();
      release();
      reject(e);
    });
    child.on("close", code => {
      clearTimeout(timer);
      unhook();
      release();
      if (timedOut) reject(new Error(timeoutMessage(c.command.timeoutMs)));
      else if (code !== 0) reject(new Error(`${a.command} exited with ${code}: ${err.trim()}`));
      else resolve({ output: out.toString("utf8"), exitCode: 0 });
    });
  });
}

/** Refusal for a batch job beyond the contract's check: its target must be registered on this laptop. */
function batchRefusal(job: JobMsg, home: string): string | null {
  const t = batchTarget(job.args);
  if ("error" in t) return t.error;
  const r = t.kind === "run" ? loadCommand(t.name, home) : loadPrompt(t.name, home);
  return "error" in r ? r.error : null;
}

/** Refusal for a workflow job before it starts: it must be registered and valid, and every step's target must be allowed by the contract and the policy
 *  (each item is checked again when it runs; this is the early, whole-workflow look). */
function workflowRefusal(job: JobMsg, home: string, implicit: string[]): string | null {
  const w = loadWorkflow(job.args.name, home);
  if ("error" in w) return w.error;
  const c = { ...job.contract, tasks: [...new Set([...job.contract.tasks, ...implicit, "run", "ask", "batch"])] };
  const loaded = loadPolicy(home);
  const policy = "policy" in loaded ? loaded.policy : null;
  for (const s of w.workflow.steps) {
    const [bk, bn] = s.kind === "batch" ? s.target.split(":") : [s.kind, s.target];
    const probe = s.kind === "run" ? { task: "run", args: { command: s.target } } : s.kind === "ask" ? { task: "ask", args: { prompt: s.target } } : { task: "batch", args: { [bk === "run" ? "command" : "prompt"]: bn, items: [{}] } };
    const v = check(c, probe, { now: Date.now(), usedToday: 0, home });
    if (v.verdict === "refuse") return `step “${s.id}”: ${v.reason}`;
    const reg = bk === "run" ? loadCommand(bn ?? s.target, home) : loadPrompt(bn ?? s.target, home);
    if ("error" in reg) return `step “${s.id}”: ${reg.error}`;
    if (policy) {
      const allowed = (bk === "run" ? policy.commands : policy.prompts) ?? [];
      if (!allowed.includes(bn ?? s.target)) return `step “${s.id}”: ${bk === "run" ? "command" : "prompt"} “${bn ?? s.target}” is not allowed by the laptop policy. To allow: mailroom policy allow-${bk === "run" ? "command" : "prompt"} ${bn ?? s.target}`;
    }
  }
  return null;
}
