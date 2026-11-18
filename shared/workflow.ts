// A workflow definition (an entry of ~/.mailroom/workflows.json): validation and the tiny reference language. Pure: no I/O.
// No code and no expressions: a value is a literal, or a whole-string reference `$name.path.to.field` to a workflow input
// (`$inputs.name`) or to an earlier step's output (`$stepId.path`). Inside a batch step's `with`, `$item.path` is the current item.
//
//   { "inputs": { "topic": { "type": "string", "required": true } },
//     "timeoutMs": 600000, "budget": { "turns": 60, "minutes": 20 }, "estimate": { "minutes": 6, "claudeTurns": 40 },
//     "steps": [
//       { "id": "list",  "run": "list-items", "args": { "topic": "$inputs.topic" } },
//       { "id": "ask",   "batch": "ask:answer", "items": "$list.items", "with": { "q": "$item" }, "concurrency": 3, "when": "$list.items" },
//       { "id": "check", "run": "check-answers", "stdin": "$ask" }
//     ] }
import type { ArgSpec } from "./args.ts";
import { parseEstimate, type Estimate } from "./estimate.ts";
import { TARGET_RE } from "./pipeline.ts";

export type Step = {
  id: string;
  kind: "run" | "ask" | "batch";
  /** run: the command; ask: the prompt; batch: "run:<command>" or "ask:<prompt>". */
  target: string;
  /** run: the command's args; ask: the prompt's vars; batch: how an item becomes the vars of one job (`with`; missing = the item itself). */
  args: Record<string, unknown>;
  items?: string; // batch: a reference to a list
  stdin?: string; // run: a reference to a value written to the script's standard input (a string as it is, anything else as JSON)
  concurrency?: number; // batch
  when?: string; // `$ref` runs the step when the value is not empty; `!$ref` when it is
};
export type Workflow = { inputs: Record<string, ArgSpec>; steps: Step[]; timeoutMs: number; budget?: { turns: number; minutes: number }; estimate?: Estimate };

export const DEFAULT_WORKFLOW_TIMEOUT_MS = 30 * 60_000;
export const MAX_WORKFLOW_TIMEOUT_MS = 6 * 3600_000;
export const MAX_STEPS = 30;
const ID_RE = /^[A-Za-z][\w-]{0,39}$/;
const NAME_RE = /^[\w.-]{1,60}$/;
const REF_RE = /^\$([A-Za-z][\w-]*)((?:\.[\w-]+)*)$/;
const RESERVED = ["inputs", "item"];
const INPUT_TYPES = ["string", "number", "boolean", "enum"];

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Is this value a reference (`$a.b`)? `$$x` is the literal string `$x`. */
export const isRef = (v: unknown): v is string => typeof v === "string" && REF_RE.test(v);

/** The root name of a reference (`inputs`, `item` or a step id), or null if the string is not one. */
export const refRoot = (v: string): string | null => REF_RE.exec(v)?.[1] ?? null;

export type Scope = { [root: string]: unknown };

/** Walks `a.b.0.c` into a value. Missing anywhere = undefined. Own properties only, so `constructor` and `__proto__` find nothing. */
export function getPath(root: unknown, path: string): unknown {
  let cur = root;
  for (const seg of path.split(".").filter(Boolean)) {
    if (cur === null || typeof cur !== "object" || !Object.hasOwn(cur as object, seg)) return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** The value of a reference in a scope; undefined when it points at nothing. */
export function resolveRef(ref: string, scope: Scope): unknown {
  const m = REF_RE.exec(ref);
  if (!m || !Object.hasOwn(scope, m[1])) return undefined;
  return getPath(scope[m[1]], m[2]);
}

/** A literal stays as it is, a reference becomes its value (undefined when missing), `$$x` becomes `$x`. */
export function resolveValue(v: unknown, scope: Scope): unknown {
  if (typeof v !== "string") return v;
  if (v.startsWith("$$")) return v.slice(1);
  return isRef(v) ? resolveRef(v, scope) : v;
}

/** Nothing in it: null, undefined, "", an empty list or an empty object. (0 and false are values.) */
export function isEmpty(v: unknown): boolean {
  if (v === null || v === undefined || v === "") return true;
  if (Array.isArray(v)) return v.length === 0;
  if (isObj(v)) return Object.keys(v).length === 0;
  return false;
}

/** Should a step with this `when` run? */
export function whenHolds(when: string | undefined, scope: Scope): boolean {
  if (when === undefined) return true;
  const neg = when.startsWith("!");
  const empty = isEmpty(resolveRef(neg ? when.slice(1) : when, scope));
  return neg ? empty : !empty;
}

/** Turns a resolved value into an argument: objects and lists become JSON text (run args and prompt variables are scalars); undefined stays unset. */
export function toArg(v: unknown): unknown {
  return v !== null && typeof v === "object" ? JSON.stringify(v) : v;
}

/** Validates one registry entry. Never throws; the error is what a job naming this workflow is refused with. */
export function parseWorkflow(name: string, raw: unknown): { workflow: Workflow } | { error: string } {
  const bad = (m: string) => ({ error: `workflow “${name}” ${m}` });
  if (!isObj(raw)) return bad("is not an object");
  const inputs: Record<string, ArgSpec> = {};
  if (raw.inputs !== undefined) {
    if (!isObj(raw.inputs)) return bad("inputs must be an object");
    for (const [k, s] of Object.entries(raw.inputs)) {
      if (!NAME_RE.test(k) || !isObj(s) || typeof s.type !== "string" || !INPUT_TYPES.includes(s.type)) return bad(`has a bad input “${k}”`);
      if (s.type === "enum" && (!Array.isArray(s.values) || s.values.some(v => typeof v !== "string"))) return bad(`input “${k}” needs values`);
      Object.defineProperty(inputs, k, { value: { type: s.type, required: s.required === true, maxLength: typeof s.maxLength === "number" ? s.maxLength : undefined, values: s.values }, enumerable: true, writable: true, configurable: true });
    }
  }
  if (!Array.isArray(raw.steps) || raw.steps.length < 1 || raw.steps.length > MAX_STEPS) return bad(`needs 1 to ${MAX_STEPS} steps`);
  const seen = new Set<string>();
  const steps: Step[] = [];
  const checkRef = (ref: unknown, where: string, allowItem: boolean): string | null => {
    if (!isRef(ref)) return `${where} must be a reference like $step.field`;
    const root = refRoot(ref)!;
    if (root === "item") return allowItem ? null : `${where} may not use $item`;
    if (root === "inputs") {
      const first = ref.split(".")[1];
      return first && Object.hasOwn(inputs, first) ? null : `${where} names an input that is not declared`;
    }
    return seen.has(root) ? null : `${where} refers to “${root}”, which is not an earlier step`;
  };
  for (const [i, s] of raw.steps.entries()) {
    const at = `step ${i + 1}`;
    if (!isObj(s)) return bad(`${at} is not an object`);
    if (typeof s.id !== "string" || !ID_RE.test(s.id) || RESERVED.includes(s.id)) return bad(`${at} needs an id (letters, digits, - and _; not “inputs” or “item”)`);
    if (seen.has(s.id)) return bad(`has two steps named “${s.id}”`);
    const kinds = (["run", "ask", "batch"] as const).filter(k => s[k] !== undefined);
    if (kinds.length !== 1) return bad(`step “${s.id}” needs exactly one of run, ask or batch`);
    const kind = kinds[0];
    const target = s[kind];
    if (typeof target !== "string" || !(kind === "batch" ? TARGET_RE.test(target) : NAME_RE.test(target))) return bad(`step “${s.id}” has a bad ${kind} target${kind === "batch" ? " (use run:<command> or ask:<prompt>)" : ""}`);
    const argKey = kind === "run" ? "args" : kind === "ask" ? "vars" : "with";
    const argv = s[argKey];
    if (argv !== undefined && !isObj(argv)) return bad(`step “${s.id}” ${argKey} must be an object`);
    for (const [k, v] of Object.entries(argv ?? {})) {
      if (!NAME_RE.test(k)) return bad(`step “${s.id}” has a bad name “${k}”`);
      if (isRef(v)) {
        const e = checkRef(v, `step “${s.id}” ${argKey}.${k}`, kind === "batch");
        if (e) return bad(e);
      } else if (v !== null && typeof v === "object") return bad(`step “${s.id}” ${argKey}.${k} must be a value or a $reference`);
    }
    const step: Step = { id: s.id, kind, target, args: { ...((argv as object) ?? {}) } };
    if (kind === "batch") {
      const e = checkRef(s.items, `step “${s.id}” items`, false);
      if (e) return bad(e);
      step.items = s.items as string;
      if (s.concurrency !== undefined) {
        if (typeof s.concurrency !== "number" || !Number.isInteger(s.concurrency) || s.concurrency < 1) return bad(`step “${s.id}” concurrency must be a whole number`);
        step.concurrency = s.concurrency;
      }
    } else if (s.items !== undefined || s.concurrency !== undefined) return bad(`step “${s.id}”: items and concurrency belong to batch steps`);
    if (s.stdin !== undefined) {
      if (kind !== "run") return bad(`step “${s.id}”: stdin belongs to run steps`);
      const e = checkRef(s.stdin, `step “${s.id}” stdin`, false);
      if (e) return bad(e);
      step.stdin = s.stdin as string;
    }
    if (s.when !== undefined) {
      if (typeof s.when !== "string") return bad(`step “${s.id}” when must be a $reference or !$reference`);
      const e = checkRef(s.when.startsWith("!") ? s.when.slice(1) : s.when, `step “${s.id}” when`, false);
      if (e) return bad(e);
      step.when = s.when;
    }
    seen.add(s.id);
    steps.push(step);
  }
  let timeoutMs = DEFAULT_WORKFLOW_TIMEOUT_MS;
  if (raw.timeoutMs !== undefined) {
    if (typeof raw.timeoutMs !== "number" || !(raw.timeoutMs > 0)) return bad("timeoutMs must be a positive number");
    timeoutMs = Math.min(raw.timeoutMs, MAX_WORKFLOW_TIMEOUT_MS);
  }
  let budget: Workflow["budget"];
  if (raw.budget !== undefined) {
    const b = raw.budget;
    if (!isObj(b) || typeof b.turns !== "number" || !(b.turns >= 1) || typeof b.minutes !== "number" || !(b.minutes > 0)) return bad("budget must look like {\"turns\": 60, \"minutes\": 20}");
    budget = { turns: Math.floor(b.turns), minutes: b.minutes };
  }
  const estimate = parseEstimate(raw.estimate);
  return { workflow: { inputs, steps, timeoutMs, ...(budget ? { budget } : {}), ...(estimate ? { estimate } : {}) } };
}
