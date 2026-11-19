// The laptop's own definitions of the local MCP servers the mcp_list and mcp_call tasks may reach: ~/.mailroom/local-mcp.json (mode 0600, read fresh for every job).
//   { "<server>": { "command": "...", "args": ["..."], "env": { "NAME": "value" }, "cwd": "/abs", "idleSeconds": 120, "callTimeoutSeconds": 30 } }
// This is the only place a command, args or env come from: a contract names a server and tools, a job names a server, a tool and arguments.
// Separate from mcp.json (the servers handed to `claude`, no env allowed) because these servers may need secrets in env, which stay on the laptop.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LOCAL_MCP_SERVER_RE } from "../shared/local-mcp.ts";

export type LocalMcpDef = { command: string; args: string[]; env: Record<string, string>; cwd: string | undefined; idleMs: number; callTimeoutMs: number };
export const localMcpPath = (home = os.homedir()) => path.join(home, ".mailroom", "local-mcp.json");
export const DEFAULT_IDLE_MS = 120_000;
export const DEFAULT_CALL_TIMEOUT_MS = 30_000;
export const MAX_CALL_TIMEOUT_MS = 5 * 60_000;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const KEYS = ["command", "args", "env", "cwd", "idleSeconds", "callTimeoutSeconds"];

/** Reads the definitions. Missing file = none. A file that is unreadable, not 0600 or malformed declares none and lists problems. Never throws. */
export function loadLocalMcp(home = os.homedir()): { servers: Record<string, LocalMcpDef>; problems: string[]; present: boolean } {
  const file = localMcpPath(home);
  const servers: Record<string, LocalMcpDef> = Object.create(null);
  const problems: string[] = [];
  let text: string;
  try {
    const st = fs.statSync(file);
    if (st.mode & 0o077) return { servers, problems: [`local-mcp.json on the laptop must be mode 0600 (chmod 600 ${file})`], present: true };
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { servers, problems, present: false };
  }
  let reg: unknown;
  try { reg = JSON.parse(text); } catch { return { servers, problems: [`${file} is not valid JSON`], present: true }; }
  if (!reg || typeof reg !== "object" || Array.isArray(reg)) return { servers, problems: [`${file} must be an object of server names`], present: true };
  for (const [name, s] of Object.entries<any>(reg)) {
    const bad = (why: string) => problems.push(`local MCP server “${name}” ${why}`);
    if (!LOCAL_MCP_SERVER_RE.test(name)) { bad("has a bad name (letters, digits and dashes, up to 40)"); continue; }
    if (!s || typeof s !== "object" || Array.isArray(s)) { bad("must be an object"); continue; }
    const extra = Object.keys(s).filter(k => !KEYS.includes(k));
    if (extra.length) { bad(`has unknown keys: ${extra.join(", ")}`); continue; }
    if (typeof s.command !== "string" || !s.command || s.command.includes("\0")) { bad("needs a command"); continue; }
    const args = s.args ?? [];
    if (!Array.isArray(args) || args.length > 50 || args.some((a: unknown) => typeof a !== "string" || a.includes("\0"))) { bad("has bad args (a list of strings)"); continue; }
    const env = s.env ?? {};
    if (!env || typeof env !== "object" || Array.isArray(env) || Object.entries(env).some(([k, v]) => !ENV_NAME_RE.test(k) || typeof v !== "string" || v.includes("\0"))) { bad("has a bad env (an object of NAME: \"value\" strings)"); continue; }
    if (s.cwd !== undefined && (typeof s.cwd !== "string" || !path.isAbsolute(s.cwd) || s.cwd.includes("\0"))) { bad("has a cwd that is not an absolute path"); continue; }
    const secs = (v: unknown, dflt: number, max: number) => (v === undefined ? Math.round(dflt * 1000) : typeof v === "number" && Number.isFinite(v) && v >= 1 && v <= max ? Math.round(v * 1000) : null);
    const idleMs = secs(s.idleSeconds, DEFAULT_IDLE_MS / 1000, 3600);
    const callTimeoutMs = secs(s.callTimeoutSeconds, DEFAULT_CALL_TIMEOUT_MS / 1000, MAX_CALL_TIMEOUT_MS / 1000);
    if (idleMs === null) { bad("has a bad idleSeconds (1 to 3600)"); continue; }
    if (callTimeoutMs === null) { bad("has a bad callTimeoutSeconds (1 to 300)"); continue; }
    servers[name] = { command: s.command, args, env: { ...env }, cwd: s.cwd, idleMs, callTimeoutMs };
  }
  return { servers, problems, present: true };
}
