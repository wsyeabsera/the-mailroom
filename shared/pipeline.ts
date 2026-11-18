// Rules for the `batch` and `workflow` tasks that the Hub and the daemon share. Pure: no I/O, no clock, no globals.
// A batch runs one registered command or prompt over a list of items, a few at a time. A workflow is a named, ordered list of
// run / ask / batch steps registered on the laptop. Every item and every step is checked like a single job.

export const BATCH_DEFAULT_CONCURRENCY = 3;
export const BATCH_MAX_CONCURRENCY = 6;
export const BATCH_DEFAULT_MAX_ITEMS = 100;
export const BATCH_MAX_ITEMS = 1000;
export const BATCH_ARG_KEYS = ["command", "prompt", "items", "concurrency"] as const;
export const WORKFLOW_ARG_KEYS = ["name", "inputs"] as const;
export const TARGET_RE = /^(run|ask):[\w.-]{1,60}$/;

export type BatchTarget = { kind: "run" | "ask"; name: string; key: string };

type PipelineContract = { batches?: string[]; commands?: string[]; prompts?: string[]; batchMaxItems?: number; batchMaxConcurrency?: number; workflows?: string[] };

/** What a contract allows a batch: the maxima (the safe defaults when the fields are missing). */
export const batchLimits = (c: { batchMaxItems?: number; batchMaxConcurrency?: number }) => ({
  maxItems: typeof c.batchMaxItems === "number" ? c.batchMaxItems : BATCH_DEFAULT_MAX_ITEMS,
  maxConcurrency: typeof c.batchMaxConcurrency === "number" ? c.batchMaxConcurrency : BATCH_DEFAULT_CONCURRENCY,
});

/** The concurrency a batch runs with: what it asked for (else the default), never above the contract's, the laptop policy's or the hard maximum. */
export const effectiveConcurrency = (asked: unknown, ...ceilings: (number | undefined)[]): number => {
  let n = typeof asked === "number" && Number.isInteger(asked) && asked >= 1 ? asked : BATCH_DEFAULT_CONCURRENCY;
  n = Math.min(n, BATCH_MAX_CONCURRENCY);
  for (const c of ceilings) if (typeof c === "number") n = Math.min(n, Math.max(1, c));
  return n;
};

/** A batch's target from its args: `command` (run) or `prompt` (ask), exactly one. */
export function batchTarget(args: Record<string, unknown> | undefined): BatchTarget | { error: string } {
  const a = args ?? {};
  const hasCmd = a.command !== undefined;
  const hasPrompt = a.prompt !== undefined;
  if (hasCmd === hasPrompt) return { error: "batch needs exactly one of command (a registered command) or prompt (a registered prompt)" };
  const name = hasCmd ? a.command : a.prompt;
  const kind = hasCmd ? "run" : "ask";
  if (typeof name !== "string" || !TARGET_RE.test(`${kind}:${name}`)) return { error: `batch ${hasCmd ? "command" : "prompt"} must be a name` };
  return { kind, name, key: `${kind}:${name}` };
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** The contract's check of a batch job: allowed target, item count, concurrency. Returns a refusal reason or null. */
export function checkBatch(c: PipelineContract, args: Record<string, unknown> | undefined): string | null {
  const a = args ?? {};
  const extra = Object.keys(a).filter(k => !(BATCH_ARG_KEYS as readonly string[]).includes(k));
  if (extra.length) return `batch takes only command or prompt, items and concurrency (not ${extra.join(", ")})`;
  const t = batchTarget(a);
  if ("error" in t) return t.error;
  if (!(c.batches ?? []).includes(t.key)) return `batch target “${t.key}” is not in the contract`;
  // Each item is a single job of the target: the same list that allows a single job allows it here.
  if (!((t.kind === "run" ? c.commands : c.prompts) ?? []).includes(t.name)) return `${t.kind === "run" ? "command" : "prompt"} “${t.name}” is not in the contract`;
  const lim = batchLimits(c);
  if (!Array.isArray(a.items) || a.items.length < 1) return "batch needs items: a non-empty list of objects";
  if (a.items.length > lim.maxItems) return `batch has ${a.items.length} items; the contract allows at most ${lim.maxItems}`;
  if (a.items.some(i => !isPlainObject(i))) return "every batch item must be an object (the arguments or variables of one job)";
  if (a.concurrency !== undefined) {
    if (typeof a.concurrency !== "number" || !Number.isInteger(a.concurrency) || a.concurrency < 1 || a.concurrency > BATCH_MAX_CONCURRENCY) return `batch concurrency must be a whole number from 1 to ${BATCH_MAX_CONCURRENCY}`;
    if (a.concurrency > lim.maxConcurrency) return `batch concurrency ${a.concurrency} is more than the contract allows (${lim.maxConcurrency})`;
  }
  return null;
}

/** The contract's check of a workflow job: allowed name, inputs an object. Returns a refusal reason or null. */
export function checkWorkflow(c: PipelineContract, args: Record<string, unknown> | undefined): string | null {
  const a = args ?? {};
  const extra = Object.keys(a).filter(k => !(WORKFLOW_ARG_KEYS as readonly string[]).includes(k));
  if (extra.length) return `workflow takes only name and inputs (not ${extra.join(", ")})`;
  if (typeof a.name !== "string" || !(c.workflows ?? []).includes(a.name)) return `workflow “${String(a.name)}” is not in the contract`;
  if (a.inputs !== undefined && !isPlainObject(a.inputs)) return "workflow inputs must be an object";
  return null;
}

/** Cuts one step or item output so a whole result stays under the cap: big values are replaced by a marker, never half a JSON value. */
export function clipValue(v: unknown, maxBytes: number): unknown {
  let s: string | undefined;
  try {
    s = JSON.stringify(v);
  } catch {
    s = undefined;
  }
  if (s === undefined) return null;
  if (new TextEncoder().encode(s).length <= maxBytes) return v;
  if (typeof v === "string") return new TextDecoder().decode(new TextEncoder().encode(v).subarray(0, maxBytes));
  return { truncated: true, bytes: new TextEncoder().encode(s).length };
}
