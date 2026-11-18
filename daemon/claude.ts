import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Tools a scratch job gets when the caller names none: read-only ones. */
export const READ_ONLY_TOOLS = ["Read", "Grep", "Glob"];

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
