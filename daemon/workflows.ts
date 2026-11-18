// The laptop's registry of workflows: ~/.mailroom/workflows.json, read fresh for every job (mode 0600, like commands.json).
// A workflow is a named, ordered list of run / ask / batch steps over registered commands and prompts. No code: see shared/workflow.ts.
// The laptop decides what runs: a job only names a workflow and supplies its declared inputs.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { COMMAND_RE } from "../shared/contract.ts";
import { parseWorkflow, type Workflow } from "../shared/workflow.ts";
import type { ArgSpec } from "../shared/args.ts";
import type { Estimate } from "../shared/estimate.ts";

export type { Workflow };
export type ReportedWorkflow = { name: string; inputs: Record<string, ArgSpec>; steps: number; timeoutMs: number; estimate?: Estimate };

export const workflowsPath = (home = os.homedir()) => path.join(home, ".mailroom", "workflows.json");

function readRegistry(home: string): { reg: Record<string, unknown> } | { error: string } {
  const file = workflowsPath(home);
  try {
    const st = fs.statSync(file);
    if (st.mode & 0o077) return { error: "workflows.json on the laptop must be mode 0600" };
    const reg = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!reg || typeof reg !== "object" || Array.isArray(reg)) return { error: "workflows.json must be an object of workflows" };
    return { reg };
  } catch {
    return { error: "no workflows.json on this laptop" };
  }
}

/** Loads one workflow. Never throws; the error text is what the job is refused with. */
export function loadWorkflow(name: unknown, home = os.homedir()): { workflow: Workflow } | { error: string } {
  if (typeof name !== "string" || !COMMAND_RE.test(name)) return { error: "workflow needs a name" };
  const r = readRegistry(home);
  if ("error" in r) return { error: r.error.startsWith("workflows.json") ? r.error : `workflow “${name}” is not registered on this laptop` };
  if (!Object.hasOwn(r.reg, name)) return { error: `workflow “${name}” is not registered on this laptop` };
  return parseWorkflow(name, r.reg[name]);
}

/** What the daemon tells the Hub on hello: name, inputs, step count, timeout and estimate. Never the steps' targets or args. */
export function listWorkflowReport(home = os.homedir()): ReportedWorkflow[] {
  const r = readRegistry(home);
  if ("error" in r) return [];
  const out: ReportedWorkflow[] = [];
  for (const name of Object.keys(r.reg)) {
    if (out.length >= 100) break;
    const w = loadWorkflow(name, home);
    if ("error" in w) continue;
    out.push({ name, inputs: w.workflow.inputs, steps: w.workflow.steps.length, timeoutMs: w.workflow.timeoutMs, ...(w.workflow.estimate ? { estimate: w.workflow.estimate } : {}) });
  }
  return out;
}
