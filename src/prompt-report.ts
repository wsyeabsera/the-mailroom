// The laptop's `ask` prompt report from its hello: prompt names and variable specs, never template text. Untrusted display data.
// A sibling of the command report (laptop_report in src/projects.ts); a daemon that sends none leaves the last snapshot as it was.
import { sanitizePromptReport, type ReportedPrompt } from "../shared/projects.ts";
import type { Sql } from "./login-limit.ts";

export const PROMPT_REPORT_TABLE = "CREATE TABLE IF NOT EXISTS laptop_prompts (id INTEGER PRIMARY KEY CHECK (id = 1), prompts TEXT NOT NULL, reported_at INTEGER NOT NULL)";

/** Replaces the stored prompt report (sanitised; never throws). */
export function storePromptReport(sql: Sql, raw: unknown, now = Date.now()) {
  const prompts = sanitizePromptReport(raw);
  sql.run("INSERT INTO laptop_prompts (id, prompts, reported_at) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET prompts = excluded.prompts, reported_at = excluded.reported_at", JSON.stringify(prompts), now);
}

export function loadPromptReport(sql: Sql): { prompts: ReportedPrompt[]; reported_at: number } | null {
  const r = sql.all<{ prompts: string; reported_at: number }>("SELECT prompts, reported_at FROM laptop_prompts WHERE id = 1")[0];
  if (!r) return null;
  try {
    return { prompts: sanitizePromptReport(JSON.parse(r.prompts)), reported_at: r.reported_at };
  } catch {
    return null;
  }
}
