// Runs the owner's local stdio MCP servers on demand. Each server starts lazily on first use, speaks newline-delimited JSON-RPC 2.0 over stdio
// (initialize, notifications/initialized, tools/list, tools/call), restarts after a crash with backoff, and is killed when idle.
// The child gets only a small fixed environment plus the env its local-mcp.json entry lists: never the daemon's own secrets.
import type { ChildProcess } from "node:child_process";
import { killTree, spawnTree } from "./proc.ts";
import { loadLocalMcp, type LocalMcpDef } from "./local-mcp.ts";

/** Safe, non-secret variables a server needs to start at all. Everything else must be listed in the server's own `env`. */
export const BASE_ENV_KEYS = ["PATH", "HOME", "LANG", "TMPDIR", "USER", "SHELL"] as const;
export const MCP_PROTOCOL_VERSION = "2025-06-18";
export const MAX_LINE_BYTES = 8 * 1024 * 1024;
export const MAX_MCP_OUTPUT_BYTES = 256 * 1024;
const MAX_TOOL_PAGES = 10;

export type McpTool = { name: string; description: string; inputSchema: unknown; readOnly: boolean };
export type McpCallResult = { isError: boolean; content: unknown[]; structuredContent?: unknown; truncated?: boolean };
type Opts = { home?: string; startTimeoutMs?: number; backoffMs?: (failures: number) => number; baseEnv?: NodeJS.ProcessEnv };

export function childEnv(def: LocalMcpDef, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of BASE_ENV_KEYS) if (typeof base[k] === "string") env[k] = base[k]!;
  return { ...env, ...def.env };
}

/** Cuts a tool result to the output cap: text parts are shortened, structuredContent is dropped when it alone is too big. Never throws. */
export function capResult(r: McpCallResult, cap = MAX_MCP_OUTPUT_BYTES): McpCallResult {
  const size = (v: unknown) => Buffer.byteLength(JSON.stringify(v) ?? "null");
  if (size(r) <= cap) return r;
  let left = cap;
  const content: unknown[] = [];
  for (const part of r.content) {
    const p = part as { type?: unknown; text?: unknown };
    if (p && p.type === "text" && typeof p.text === "string") {
      if (left <= 0) break;
      const text = Buffer.from(p.text).subarray(0, Math.max(0, left - 64)).toString("utf8");
      content.push({ type: "text", text });
      left -= Buffer.byteLength(text) + 32;
    } else if (size(part) <= left) { content.push(part); left -= size(part); }
  }
  const out: McpCallResult = { isError: r.isError, content, truncated: true };
  if (r.structuredContent !== undefined && size(r.structuredContent) <= Math.max(0, left)) out.structuredContent = r.structuredContent;
  return out;
}

class Server {
  child: ChildProcess | null = null;
  ready: Promise<void> | null = null;
  pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  nextId = 1;
  buf = "";
  tools: McpTool[] | null = null;
  failures = 0;
  retryAt = 0;
  idle: NodeJS.Timeout | null = null;
  specKey = "";
  stderr = "";
  name: string;
  constructor(name: string) { this.name = name; }
}

export class McpSupervisor {
  private servers = new Map<string, Server>();
  private opts: Opts;
  constructor(opts: Opts = {}) { this.opts = opts; }
  private get home() { return this.opts.home; }

  /** Names of the servers that currently have a live process (for tests and doctor). */
  running(): string[] { return [...this.servers.values()].filter(s => s.child).map(s => s.name); }
  pidOf(name: string): number | undefined { return this.servers.get(name)?.child?.pid; }

  private def(name: string): LocalMcpDef {
    const { servers, problems } = loadLocalMcp(this.home);
    if (!Object.hasOwn(servers, name)) throw new Error(`local MCP server “${name}” is not defined on this laptop${problems.length ? ` (${problems[0]})` : ""}`);
    return servers[name];
  }

  /** The per-call timeout the laptop set for this server. */
  callTimeoutMs(name: string): number { return this.def(name).callTimeoutMs; }

  private touch(s: Server, def: LocalMcpDef) {
    if (s.idle) clearTimeout(s.idle);
    s.idle = setTimeout(() => { if (s.pending.size === 0) this.kill(s); else this.touch(s, def); }, def.idleMs);
    s.idle.unref();
  }

  private kill(s: Server) {
    if (s.idle) clearTimeout(s.idle);
    s.idle = null;
    const c = s.child;
    s.child = null;
    s.ready = null;
    s.tools = null;
    if (c) killTree(c);
    this.failAll(s, new Error(`local MCP server “${s.name}” was stopped`));
  }

  private failAll(s: Server, e: Error) {
    for (const p of s.pending.values()) p.reject(e);
    s.pending.clear();
  }

  private write(s: Server, msg: unknown) {
    s.child?.stdin?.write(JSON.stringify(msg) + "\n");
  }

  private onLine(s: Server, line: string) {
    let m: any;
    try { m = JSON.parse(line); } catch { return; } // not JSON-RPC (a stray log line): ignore
    if (!m || typeof m !== "object") return;
    if (typeof m.method === "string") {
      // A request from the server (ping, sampling, roots...): answer ping, refuse everything else. Notifications are ignored.
      if (m.id !== undefined) this.write(s, m.method === "ping" ? { jsonrpc: "2.0", id: m.id, result: {} } : { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "not supported" } });
      return;
    }
    const p = typeof m.id === "number" ? s.pending.get(m.id) : undefined;
    if (!p) return;
    s.pending.delete(m.id);
    if (m.error) p.reject(new Error(`MCP error ${m.error.code ?? ""}: ${String(m.error.message ?? "unknown").slice(0, 500)}`));
    else p.resolve(m.result);
  }

  private request(s: Server, method: string, params: unknown, ms: number, signal?: AbortSignal): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!s.child) return reject(new Error(`local MCP server “${s.name}” is not running`));
      if (signal?.aborted) return reject(new Error("cancelled"));
      const id = s.nextId++;
      const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); };
      const timer = setTimeout(() => {
        s.pending.delete(id);
        done();
        // The server's state after a timed-out call is unknown: stop it; the next call starts a fresh one.
        this.kill(s);
        reject(new Error(`${method} on “${s.name}” timed out after ${Math.max(1, Math.round(ms / 1000))}s`));
      }, ms);
      const onAbort = () => { s.pending.delete(id); done(); this.write(s, { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id } }); reject(new Error("cancelled")); };
      signal?.addEventListener("abort", onAbort, { once: true });
      s.pending.set(id, { resolve: v => { done(); resolve(v); }, reject: e => { done(); reject(e); } });
      this.write(s, { jsonrpc: "2.0", id, method, params });
    });
  }

  private start(s: Server, def: LocalMcpDef): Promise<void> {
    if (s.ready) return s.ready;
    const wait = s.retryAt - Date.now();
    if (wait > 0) return Promise.reject(new Error(`local MCP server “${s.name}” crashed; restarting in ${Math.ceil(wait / 1000)}s (try again then)`));
    let child: ChildProcess;
    try {
      child = spawnTree(def.command, def.args, { cwd: def.cwd, env: childEnv(def, this.opts.baseEnv), stdio: ["pipe", "pipe", "pipe"], shell: false });
    } catch (e) {
      return Promise.reject(e);
    }
    s.child = child;
    s.buf = "";
    s.stderr = "";
    s.tools = null;
    child.stdin!.on("error", () => {});
    child.stdout!.on("data", (d: Buffer) => {
      if (s.child !== child) return;
      s.buf += d.toString("utf8");
      if (s.buf.length > MAX_LINE_BYTES) { this.crashed(s, child, "wrote a line over the size cap"); return; }
      let i: number;
      while ((i = s.buf.indexOf("\n")) >= 0) {
        const line = s.buf.slice(0, i).trim();
        s.buf = s.buf.slice(i + 1);
        if (line) this.onLine(s, line);
      }
    });
    child.stderr!.on("data", (d: Buffer) => { s.stderr = (s.stderr + d).slice(-1000); });
    child.on("error", e => { if (s.child === child) this.crashed(s, child, e.message); });
    child.on("close", code => { if (s.child === child) this.crashed(s, child, `exited with ${code}${s.stderr.trim() ? `: ${s.stderr.trim()}` : ""}`); });
    const ready = (async () => {
      await this.request(s, "initialize", { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "mailroom", version: "1" } }, this.opts.startTimeoutMs ?? 15_000);
      this.write(s, { jsonrpc: "2.0", method: "notifications/initialized" });
    })();
    s.ready = ready;
    ready.catch(() => { if (s.ready === ready) { s.ready = null; if (s.child === child) { s.child = null; killTree(child); } } });
    return ready;
  }

  private crashed(s: Server, child: ChildProcess, why: string) {
    s.child = null;
    s.ready = null;
    s.tools = null;
    killTree(child);
    s.failures++;
    const back = this.opts.backoffMs ? this.opts.backoffMs(s.failures) : Math.min(30_000, 500 * 2 ** (s.failures - 1));
    s.retryAt = Date.now() + back;
    if (s.idle) clearTimeout(s.idle);
    s.idle = null;
    this.failAll(s, new Error(`local MCP server “${s.name}” ${why}`));
  }

  private async use(name: string): Promise<{ s: Server; def: LocalMcpDef }> {
    const def = this.def(name);
    let s = this.servers.get(name);
    if (!s) this.servers.set(name, (s = new Server(name)));
    const key = JSON.stringify([def.command, def.args, def.env, def.cwd]);
    if (s.child && s.specKey !== key) this.kill(s); // the owner edited the definition: use the new one
    s.specKey = key;
    await this.start(s, def);
    this.touch(s, def);
    return { s, def };
  }

  /** Every tool the server offers (all pages), with the readOnly flag from its annotations. Cached while the process lives. */
  async listTools(name: string, signal?: AbortSignal): Promise<McpTool[]> {
    const { s, def } = await this.use(name);
    if (s.tools) return s.tools;
    const out: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_TOOL_PAGES; page++) {
      const r = await this.request(s, "tools/list", cursor ? { cursor } : {}, def.callTimeoutMs, signal);
      for (const t of Array.isArray(r?.tools) ? r.tools : []) {
        if (!t || typeof t.name !== "string") continue;
        out.push({ name: t.name, description: typeof t.description === "string" ? t.description.slice(0, 2000) : "", inputSchema: t.inputSchema ?? { type: "object" }, readOnly: t.annotations?.readOnlyHint === true });
      }
      cursor = typeof r?.nextCursor === "string" && r.nextCursor ? r.nextCursor : undefined;
      if (!cursor) break;
    }
    s.tools = out;
    s.failures = 0;
    return out;
  }

  /** Calls one tool. The result is capped; the call has the server's timeout (or `timeoutMs`, whichever is smaller) and ends early on abort. */
  async callTool(name: string, tool: string, args: Record<string, unknown>, o: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<McpCallResult> {
    const { s, def } = await this.use(name);
    const r = await this.request(s, "tools/call", { name: tool, arguments: args }, Math.min(def.callTimeoutMs, o.timeoutMs ?? Infinity), o.signal);
    s.failures = 0;
    this.touch(s, def);
    return capResult({ isError: r?.isError === true, content: Array.isArray(r?.content) ? r.content : [], ...(r?.structuredContent !== undefined ? { structuredContent: r.structuredContent } : {}) });
  }

  /** Stops every server now. */
  shutdown() { for (const s of this.servers.values()) this.kill(s); }
}

let shared: McpSupervisor | null = null;
/** The daemon's one supervisor. Its children die with the daemon. */
export function sharedSupervisor(): McpSupervisor {
  if (!shared) {
    shared = new McpSupervisor();
    process.once("exit", () => shared?.shutdown());
  }
  return shared;
}
