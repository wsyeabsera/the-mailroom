// The laptop's workflow report from its hello: workflow names, inputs, step count, timeout and estimate, never the steps. Untrusted display data.
// A sibling of the prompt report (src/prompt-report.ts); a daemon that sends none leaves the last snapshot as it was.
import { sanitizeWorkflowReport, type ReportedWorkflow } from "../shared/projects.ts";
import type { Sql } from "./login-limit.ts";

export const WORKFLOW_REPORT_TABLE = "CREATE TABLE IF NOT EXISTS laptop_workflows (id INTEGER PRIMARY KEY CHECK (id = 1), workflows TEXT NOT NULL, reported_at INTEGER NOT NULL)";

/** Replaces the stored workflow report (sanitised; never throws). */
export function storeWorkflowReport(sql: Sql, raw: unknown, now = Date.now()) {
  const workflows = sanitizeWorkflowReport(raw);
  sql.run("INSERT INTO laptop_workflows (id, workflows, reported_at) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET workflows = excluded.workflows, reported_at = excluded.reported_at", JSON.stringify(workflows), now);
}

export function loadWorkflowReport(sql: Sql): { workflows: ReportedWorkflow[]; reported_at: number } | null {
  const r = sql.all<{ workflows: string; reported_at: number }>("SELECT workflows, reported_at FROM laptop_workflows WHERE id = 1")[0];
  if (!r) return null;
  try {
    return { workflows: sanitizeWorkflowReport(JSON.parse(r.workflows)), reported_at: r.reported_at };
  } catch {
    return null;
  }
}
