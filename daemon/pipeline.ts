// The `batch` and `workflow` tasks. Both only compose single jobs: every item and every step goes through the same
// recheck (contract, laptop policy, registered cwd) and the same runTask as a job of its own, and shares one Claude budget.
// Cancel (the signal) stops them all. Nothing here runs code of its own.
import os from "node:os";
import { effectiveConcurrency, batchLimits, batchTarget, clipValue, type BatchTarget } from "../shared/pipeline.ts";
import { resolveRef, resolveValue, toArg, whenHolds, type Scope } from "../shared/workflow.ts";
import { MAX_RESULT_BYTES } from "../shared/limits.ts";
import type { Usage } from "../shared/claude-budget.ts";
import { timeoutMessage } from "./proc.ts";
import { loadPolicy } from "./policy.ts";
import { loadWorkflow } from "./workflows.ts";
import { checkVars } from "./prompts.ts";
import { recheck, runTask, type JobMsg } from "./tasks.ts";

/** What is left of a Claude budget, shared by every item and step of one batch or workflow. Unlimited when the Hub sent none. */
export class Meter {
  turns = Infinity;
  ms = Infinity;
  used: Usage = { turns: 0, ms: 0 };
  constructor(budget?: { turns: number; ms: number }) {
    if (budget) {
      if (Number.isFinite(budget.turns)) this.turns = budget.turns;
      if (Number.isFinite(budget.ms)) this.ms = budget.ms;
    }
  }
  /** A workflow's own ceiling, on top of what the key has left. */
  clip(w?: { turns: number; minutes: number }) {
    if (!w) return;
    this.turns = Math.min(this.turns, w.turns);
    this.ms = Math.min(this.ms, w.minutes * 60_000);
  }
  add(u: Usage) {
    this.used = { turns: this.used.turns + u.turns, ms: this.used.ms + u.ms };
    this.turns -= u.turns;
    this.ms -= u.ms;
  }
  snapshot(): { turns: number; ms: number } | undefined {
    return Number.isFinite(this.turns) || Number.isFinite(this.ms) ? { turns: this.turns, ms: this.ms } : undefined;
  }
}

type Env = {
  job: JobMsg;
  signal: AbortSignal;
  meter: Meter;
  home: string;
  seq: { n: number };
};
export type ItemResult = { index: number; ok: true; value: unknown } | { index: number; ok: false; error: string };

/** The value a step or item produced: an ask's answer (parsed when its prompt has a schema); a run's output, parsed when it is JSON, else the text. */
export function stepValue(kind: "run" | "ask", result: unknown): unknown {
  const r = (result ?? {}) as { output?: unknown };
  if (kind === "ask") return r.output;
  const text = String(r.output ?? "").trim();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const budgetMessage = "the Claude budget is used up";

/** Runs one item or step as a single job of its own: same recheck, same runTask. Never throws. */
async function runOne(env: Env, kind: "run" | "ask", name: string, args: Record<string, unknown>, slice: { turns: number; ms: number } | undefined, opts: { report?: (t: string, p?: number) => void; onPartial?: (v: unknown) => void; stdin?: string } = {}): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  if (env.signal.aborted) return { ok: false, error: "cancelled" };
  const sub: JobMsg = { id: `${env.job.id}-${++env.seq.n}`, task: kind, args: kind === "run" ? { command: name, args } : { prompt: name, vars: args }, contract: env.job.contract, ...(slice ? { budget: slice } : {}) };
  const v = recheck(sub, Date.now(), env.home, [kind]);
  if ("reason" in v) return { ok: false, error: v.reason };
  try {
    const result = await runTask(sub, v.resolved, env.signal, opts.report ?? (() => {}), u => env.meter.add(u), opts.onPartial ?? (() => {}), { stdin: opts.stdin });
    return { ok: true, value: stepValue(kind, result) };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** Runs a list of items of one target, `concurrency` at a time. A failed item is recorded and the rest go on. Claude items each get an equal slice of
 *  what is left of the budget, so the items running together cannot spend more than there is; once it is used up, the remaining items fail without running. */
async function runItems(env: Env, t: BatchTarget, items: Record<string, unknown>[], concurrency: number, onDone: (r: ItemResult, done: number) => void): Promise<ItemResult[]> {
  const n = items.length;
  const results: ItemResult[] = new Array(n);
  let next = 0;
  let done = 0;
  let inFlight = 0;
  let reservedTurns = 0;
  let reservedMs = 0;
  let waiters: (() => void)[] = [];
  const wake = () => { const w = waiters; waiters = []; for (const f of w) f(); };
  const part = (total: number, reserved: number, idle: number) => (Number.isFinite(total) ? Math.floor((total - reserved) / idle) : Infinity);
  const finish = (i: number, r: ItemResult) => { results[i] = r; done++; onDone(r, done); };

  async function worker() {
    for (;;) {
      if (env.signal.aborted || next >= n) return;
      const i = next;
      let slice: { turns: number; ms: number } | undefined;
      if (t.kind === "ask") {
        // Split what is free among the idle workers (but never into slices smaller than one turn).
        const idle = concurrency - inFlight;
        const freeTurns = env.meter.turns - reservedTurns;
        const share = Number.isFinite(freeTurns) ? Math.max(1, Math.min(idle, Math.floor(freeTurns))) : idle;
        const turns = part(env.meter.turns, reservedTurns, share);
        const ms = part(env.meter.ms, reservedMs, share);
        if (turns < 1 || ms < 1000) {
          if (inFlight > 0) { await new Promise<void>(r => waiters.push(r)); continue; } // wait for a running item to give its share back
          next++;
          finish(i, { index: i, ok: false, error: budgetMessage });
          continue;
        }
        slice = { turns, ms };
        if (Number.isFinite(turns)) reservedTurns += turns;
        if (Number.isFinite(ms)) reservedMs += ms;
      }
      next++;
      inFlight++;
      let r: { ok: true; value: unknown } | { ok: false; error: string };
      try {
        r = await runOne(env, t.kind, t.name, items[i], slice);
      } finally {
        inFlight--;
        if (slice) {
          if (Number.isFinite(slice.turns)) reservedTurns -= slice.turns;
          if (Number.isFinite(slice.ms)) reservedMs -= slice.ms;
        }
        wake();
      }
      finish(i, { index: i, ...r });
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, n) }, worker));
  return results.filter(Boolean);
}

/** A batch's items as one result list: each value cut so the whole result stays under the cap. */
function summarize(results: ItemResult[], n: number) {
  const each = Math.max(2000, Math.floor((MAX_RESULT_BYTES * 0.75) / Math.max(1, n)));
  const items = results.map(r => (r.ok ? { index: r.index, ok: true as const, value: clipValue(r.value, each) } : r));
  return { total: n, done: items.filter(i => i.ok).length, failed: items.filter(i => !i.ok).length, items };
}

const partialOf = (r: ItemResult, extra: Record<string, unknown> = {}) => ({ ...extra, ...(r.ok ? { index: r.index, ok: true, value: clipValue(r.value, 4000) } : { index: r.index, ok: false, error: r.error.slice(0, 500) }) });

/** The `batch` task: one registered command or prompt over `items`, a few at a time. */
export async function runBatch(job: JobMsg, signal: AbortSignal, report: (text: string, pct?: number) => void, onUsage: (u: Usage) => void, onPartial: (v: unknown) => void, home = os.homedir()): Promise<unknown> {
  const a = job.args;
  const t = batchTarget(a);
  if ("error" in t) throw new Error(t.error);
  const items = a.items as Record<string, unknown>[];
  const pol = loadPolicy(home);
  const concurrency = effectiveConcurrency(a.concurrency, batchLimits(job.contract).maxConcurrency, "policy" in pol ? pol.policy?.batchMaxConcurrency : undefined);
  const env: Env = { job, signal, meter: new Meter(job.budget), home, seq: { n: 0 } };
  report(`0 of ${items.length}`, 0);
  let results: ItemResult[];
  try {
    results = await runItems(env, t, items, concurrency, (r, done) => {
      report(`${done} of ${items.length}`, Math.round((done / items.length) * 100));
      onPartial(partialOf(r));
    });
  } finally {
    if (env.meter.used.turns || env.meter.used.ms) onUsage(env.meter.used); // on every outcome, cancel included
  }
  return summarize(results, items.length);
}

/** The `workflow` task: the laptop's registered steps, in order. */
export async function runWorkflow(job: JobMsg, signal: AbortSignal, report: (text: string, pct?: number) => void, onUsage: (u: Usage) => void, onPartial: (v: unknown) => void, home = os.homedir()): Promise<unknown> {
  const w = loadWorkflow(job.args.name, home);
  if ("error" in w) throw new Error(w.error);
  const def = w.workflow;
  const inputs = checkVars(def.inputs, job.args.inputs);
  if ("error" in inputs) throw new Error(`workflow inputs: ${inputs.error}`);

  const ctl = new AbortController();
  const stop = () => ctl.abort();
  if (signal.aborted) ctl.abort();
  else signal.addEventListener("abort", stop, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, def.timeoutMs);
  const meter = new Meter(job.budget);
  meter.clip(def.budget);
  const env: Env = { job, signal: ctl.signal, meter, home, seq: { n: 0 } };
  const scope: Scope = { inputs: inputs.vars };
  const log: { id: string; kind: string; status: "done" | "skipped" | "failed"; ms: number; error?: string }[] = [];
  let output: unknown = null;
  const total = def.steps.length;
  const fail = (id: string, kind: string, ms: number, error: string): never => {
    log.push({ id, kind, status: "failed", ms, error });
    onPartial({ step: id, status: "failed", error: error.slice(0, 500) });
    const ok = log.filter(s => s.status !== "failed").map(s => `${s.id} ${s.status}`).join(", ");
    throw new Error(`step “${id}” failed: ${error}${ok ? ` (before it: ${ok})` : ""}`);
  };

  try {
    for (const [i, step] of def.steps.entries()) {
      if (ctl.signal.aborted) break;
      const at = `step ${i + 1} of ${total}: ${step.id}`;
      const t0 = Date.now();
      if (!whenHolds(step.when, scope)) {
        scope[step.id] = null;
        log.push({ id: step.id, kind: step.kind, status: "skipped", ms: 0 });
        onPartial({ step: step.id, status: "skipped" });
        continue;
      }
      report(at);
      const resolve = (spec: Record<string, unknown>, extra: Scope = {}) => {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(spec)) {
          const r = toArg(resolveValue(v, { ...scope, ...extra }));
          if (r !== undefined) out[k] = r;
        }
        return out;
      };
      let value: unknown;
      if (step.kind === "batch") {
        const list = resolveRef(step.items!, scope);
        if (!Array.isArray(list)) fail(step.id, step.kind, Date.now() - t0, `${step.items} is not a list`);
        const items = (list as unknown[]).map(it => (Object.keys(step.args).length ? resolve(step.args, { item: it }) : it));
        if (items.some(it => !it || typeof it !== "object" || Array.isArray(it))) fail(step.id, step.kind, Date.now() - t0, "every item must become an object (add a `with` that names the variables)");
        const [kind, name] = step.target.split(":") as ["run" | "ask", string];
        const batchArgs = { [kind === "run" ? "command" : "prompt"]: name, items, ...(step.concurrency ? { concurrency: step.concurrency } : {}) };
        // The step is checked like a batch job of its own: the contract's batch targets and limits, and the laptop policy's.
        const v = recheck({ id: `${job.id}-${++env.seq.n}`, task: "batch", args: batchArgs, contract: job.contract }, Date.now(), home, ["run", "ask"]);
        if ("reason" in v) fail(step.id, step.kind, Date.now() - t0, v.reason);
        const pol = loadPolicy(home);
        const conc = effectiveConcurrency(step.concurrency, batchLimits(job.contract).maxConcurrency, "policy" in pol ? pol.policy?.batchMaxConcurrency : undefined);
        report(`${at}: 0 of ${items.length}`);
        const results = await runItems(env, { kind, name, key: step.target }, items as Record<string, unknown>[], conc, (r, done) => {
          report(`${at}: ${done} of ${items.length}`);
          onPartial(partialOf(r, { step: step.id }));
        });
        value = results.map(r => (r.ok ? { index: r.index, ok: true, value: r.value } : r));
      } else {
        const args = resolve(step.args);
        let stdin: string | undefined;
        if (step.stdin) {
          const sv = resolveRef(step.stdin, scope);
          if (sv !== undefined) stdin = typeof sv === "string" ? sv : JSON.stringify(sv);
        }
        const r = await runOne(env, step.kind, step.target, args, step.kind === "ask" ? meter.snapshot() : undefined, {
          report: (text, pct) => report(`${at}: ${text}`, pct),
          onPartial: v => onPartial({ step: step.id, partial: v }),
          stdin,
        });
        if (!r.ok) {
          if (ctl.signal.aborted) break;
          fail(step.id, step.kind, Date.now() - t0, r.error);
        } else value = r.value;
      }
      if (ctl.signal.aborted) break;
      scope[step.id] = value;
      output = value;
      log.push({ id: step.id, kind: step.kind, status: "done", ms: Date.now() - t0 });
      onPartial({ step: step.id, status: "done" });
    }
    if (timedOut) throw new Error(timeoutMessage(def.timeoutMs));
    if (ctl.signal.aborted) throw new Error("cancelled");
    return { output: clipValue(output, Math.floor(MAX_RESULT_BYTES * 0.75)), steps: log };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", stop);
    if (meter.used.turns || meter.used.ms) onUsage(meter.used);
  }
}
