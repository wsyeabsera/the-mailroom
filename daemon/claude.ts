import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Tools a scratch job gets when the caller names none: read-only ones. */
export const READ_ONLY_TOOLS = ["Read", "Grep", "Glob"];

/** Built-in tools that can leave the folder or reach the network. A claude job gets none of them unless its (contract-checked) allowedTools names it. */
export const RISKY_TOOLS = ["Bash", "Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch"];
/** File tools whose bare grant is rewritten to the job's folders. Edit rules cover Write and NotebookEdit too (verified live, claude 2.1.328). */
const READ_TOOLS = ["Read", "Glob", "Grep"];
const EDIT_TOOLS = ["Edit", "Write", "NotebookEdit"];

/** `//abs/dir/**` for a permission rule. Refuses folders whose name holds characters a rule would read as syntax. */
export function ruleDir(dir: string): string {
  if (!path.isAbsolute(dir)) throw new Error(`job folder ${dir} is not absolute`);
  if (/[*?\[\]{}()!#\\\0\n\r,]/.test(dir)) throw new Error(`job folder ${JSON.stringify(dir)} has a character that cannot be written in a permission rule (one of * ? [ ] { } ( ) ! # \\ ,)`);
  return `/${dir.replace(/\/+$/, "")}/**`;
}

/** Confines a claude argv to `dirs` (the job's working folder, and for scratch the contract folder).
 *  - bare Read/Glob/Grep in --allowedTools become Read(//dir/**) ...; bare Edit/Write/NotebookEdit become Edit(//dir/**). A bare grant would let the job read or write anywhere (verified live: `--allowedTools Read` returned a file outside cwd).
 *  - entries that already carry a pattern, MCP tools, WebFetch, WebSearch and Bash(...) pass through unchanged (the contract already vetted them).
 *  - every risky tool not granted is removed with --disallowedTools.
 *  - --permission-mode dontAsk: anything not allowed is denied, never prompted. Denials come back in the result event's permission_denials.
 *  Pure; the argv is not mutated. */
export function confineArgv(argv: string[], dirs: string[]): string[] {
  const out = [...argv];
  const i = out.indexOf("--allowedTools");
  const granted: string[] = [];
  if (i >= 0) {
    let j = i + 1;
    while (j < out.length && !out[j].startsWith("--")) j++;
    const rules = dirs.map(ruleDir);
    const next: string[] = [];
    for (const t of out.slice(i + 1, j)) {
      granted.push(t.replace(/\(.*$/s, ""));
      if (READ_TOOLS.includes(t)) next.push(...rules.map(r => `${t}(${r})`));
      else if (EDIT_TOOLS.includes(t)) next.push(...rules.map(r => `Edit(${r})`));
      else next.push(t);
    }
    out.splice(i + 1, j - i - 1, ...new Set(next));
  }
  const denied = RISKY_TOOLS.filter(t => !granted.includes(t));
  const tail = [...(denied.length ? ["--disallowedTools", ...denied] : []), "--permission-mode", "dontAsk"];
  return [...out, ...tail];
}

/** Create ~/.mailroom/scratch/<jobid>-<unique> (fresh, mode 0700). */
export function makeScratch(jobId: string, home = os.homedir()): string {
  const safe = jobId.replace(/[^\w-]/g, "_").slice(0, 80) || "job";
  const dir = path.join(home, ".mailroom", "scratch", `${safe}-${process.pid}-${Date.now().toString(36)}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function removeScratch(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Reads `--output-format stream-json` lines: reports short progress text per assistant turn, keeps the final result event. */
export class StreamReader {
  turn = 0;
  result: Record<string, unknown> | null = null;
  private buf = "";
  private report: (text: string) => void;
  constructor(report: (text: string) => void) { this.report = report; }

  push(chunk: Buffer | string): void {
    const lines = (this.buf + chunk).split("\n");
    this.buf = lines.pop()!.slice(-1_000_000);
    for (const l of lines) this.line(l);
  }
  end(): void {
    if (this.buf) this.line(this.buf);
    this.buf = "";
  }
  private line(l: string): void {
    let ev: any;
    try { ev = JSON.parse(l); } catch { return; }
    if (!ev || typeof ev !== "object") return;
    if (ev.type === "result") { this.result = ev; return; }
    if (ev.type !== "assistant") return;
    this.turn++;
    const content = Array.isArray(ev.message?.content) ? ev.message.content : [];
    const tools = content.filter((c: any) => c?.type === "tool_use" && typeof c.name === "string").map((c: any) => c.name);
    this.report(tools.length ? `turn ${this.turn}: using ${tools.slice(0, 3).join(", ")}` : `turn ${this.turn}`);
  }
}

export const MAX_DENIALS = 20;
export const MAX_DENIAL_INPUT_CHARS = 2000;
export type Denial = { tool_name: string; tool_use_id: string; tool_input: unknown };

/** Token-shaped strings (Mailroom keys and admin tokens, common API key prefixes, bearer headers, JWTs, long opaque runs) replaced with [redacted]. */
export function redactSecrets(s: string): string {
  return s
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/=-]{8,}/gi, "Bearer [redacted]")
    .replace(/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]*/g, "[redacted]")
    .replace(/\b(?:mr[a-z]_|sk-|pk-|ghp_|gho_|ghs_|github_pat_|xox[a-z]-|AKIA)[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, "[redacted]");
}

/** The `permission_denials` of a claude result event, bounded: at most MAX_DENIALS entries, each tool_input at most
 *  MAX_DENIAL_INPUT_CHARS characters (as JSON; over that it becomes a cut string) and redacted of token-shaped strings. Never the transcript. */
export function boundedDenials(result: unknown): Denial[] {
  const raw = result && typeof result === "object" ? (result as Record<string, unknown>).permission_denials : undefined;
  if (!Array.isArray(raw)) return [];
  const out: Denial[] = [];
  for (const d of raw.slice(0, MAX_DENIALS)) {
    if (!d || typeof d !== "object") continue;
    const o = d as Record<string, unknown>;
    let json: string;
    try { json = JSON.stringify(o.tool_input) ?? "null"; } catch { json = "null"; }
    json = redactSecrets(json);
    let input: unknown;
    if (json.length > MAX_DENIAL_INPUT_CHARS) input = json.slice(0, MAX_DENIAL_INPUT_CHARS);
    else { try { input = JSON.parse(json); } catch { input = json; } }
    out.push({ tool_name: redactSecrets(String(o.tool_name ?? "")).slice(0, 100), tool_use_id: String(o.tool_use_id ?? "").slice(0, 100), tool_input: input });
  }
  return out;
}
