// MCP servers a prompt may use: ~/.mailroom/mcp.json (mode 0600, read fresh for every job) declares which servers the laptop will start for Claude,
// as { "<server>": { "command": "...", "args": ["..."] } }. No secrets and no environment in it: an entry with any other key is a problem.
// A prompt (or claude job) names one tool at a time as `mcp__<server>__<tool>`; the daemon starts only the servers its allowed tools name,
// with `--strict-mcp-config`, so nothing else the laptop has configured for Claude is reachable. A server that is not declared here refuses the job.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MCP_TOOL_RE } from "../shared/contract.ts";

export type McpServer = { command: string; args: string[] };
export const mcpPath = (home = os.homedir()) => path.join(home, ".mailroom", "mcp.json");

const SERVER_RE = /^[A-Za-z0-9-]{1,40}$/;

/** The server a tool name belongs to, or null when it is not an `mcp__<server>__<tool>` name. */
export function mcpServerOf(tool: string): string | null {
  return MCP_TOOL_RE.exec(tool)?.[1] ?? null;
}

/** Reads the declared servers. Missing file = none. A file that is unreadable, not 0600 or malformed declares none and lists problems. Never throws. */
export function loadMcpServers(home = os.homedir()): { servers: Record<string, McpServer>; problems: string[]; present: boolean } {
  const file = mcpPath(home);
  const servers: Record<string, McpServer> = Object.create(null);
  const problems: string[] = [];
  let text: string;
  try {
    const st = fs.statSync(file);
    if (st.mode & 0o077) return { servers, problems: [`mcp.json on the laptop must be mode 0600 (chmod 600 ${file})`], present: true };
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { servers, problems, present: false };
  }
  let reg: unknown;
  try { reg = JSON.parse(text); } catch { return { servers, problems: [`${file} is not valid JSON`], present: true }; }
  if (!reg || typeof reg !== "object" || Array.isArray(reg)) return { servers, problems: [`${file} must be an object of server names`], present: true };
  for (const [name, s] of Object.entries<any>(reg)) {
    const bad = (why: string) => problems.push(`MCP server “${name}” ${why}`);
    if (!SERVER_RE.test(name)) { bad("has a bad name (letters, digits and dashes, up to 40)"); continue; }
    if (!s || typeof s !== "object" || Array.isArray(s)) { bad("must be an object with command and args"); continue; }
    const extra = Object.keys(s).filter(k => k !== "command" && k !== "args");
    if (extra.length) { bad(`has ${extra.join(", ")}: only command and args are allowed (no environment, no secrets)`); continue; }
    if (typeof s.command !== "string" || !s.command || s.command.includes("\0")) { bad("needs a command"); continue; }
    const args = s.args ?? [];
    if (!Array.isArray(args) || args.length > 50 || args.some((a: unknown) => typeof a !== "string" || a.includes("\0"))) { bad("has bad args (a list of strings)"); continue; }
    servers[name] = { command: s.command, args };
  }
  return { servers, problems, present: true };
}

/** The refusal reason when a tool list needs an MCP server this laptop has not declared, else null. */
export function mcpRefusal(tools: string[], home = os.homedir()): string | null {
  const used = [...new Set(tools.map(mcpServerOf).filter((s): s is string => s !== null))];
  if (!used.length) return null;
  const { servers, problems } = loadMcpServers(home);
  for (const s of used) {
    if (!Object.hasOwn(servers, s)) return `MCP server “${s}” is not declared on this laptop${problems.length ? ` (${problems[0]})` : ""}. Declare it in ${mcpPath(home)} as {"${s}": {"command": "...", "args": [...]}}`;
  }
  return null;
}

/** claude's flags to start exactly the declared servers the allowed tools name, and no other MCP config. */
export function mcpConfigArgs(tools: string[], home = os.homedir()): { argv: string[] } | { error: string } {
  const used = [...new Set(tools.map(mcpServerOf).filter((s): s is string => s !== null))];
  if (!used.length) return { argv: [] };
  const bad = mcpRefusal(tools, home);
  if (bad) return { error: bad };
  const { servers } = loadMcpServers(home);
  const mcpServers: Record<string, McpServer> = {};
  for (const s of used) mcpServers[s] = servers[s];
  // --mcp-config takes a list, so --strict-mcp-config (a flag) must follow it directly.
  return { argv: ["--mcp-config", JSON.stringify({ mcpServers }), "--strict-mcp-config"] };
}
