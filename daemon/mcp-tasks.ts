// The mcp_list and mcp_call tasks: tools of the owner's local MCP servers, filtered and checked against the contract the Hub sent.
import os from "node:os";
import { findLocalMcpTool, hasLocalMcpServer } from "../shared/local-mcp.ts";
import type { Contract } from "../shared/contract.ts";
import { loadLocalMcp } from "./local-mcp.ts";
import { sharedSupervisor, type McpSupervisor } from "./mcp-supervisor.ts";

type Job = { task: string; args: Record<string, unknown>; contract: Contract };

/** Refusal reason before the job starts: the server must be defined on this laptop. (The contract check already ran.) */
export function localMcpRefusal(job: Job, home = os.homedir()): string | null {
  const a = job.args ?? {};
  const { servers, problems } = loadLocalMcp(home);
  const wanted = typeof a.server === "string" ? [a.server] : (job.contract.localMcp ?? []).map(s => s.server);
  for (const w of wanted) if (!Object.hasOwn(servers, w)) return `local MCP server “${w}” is not defined on this laptop${problems.length ? ` (${problems[0]})` : ""}. Define it in ~/.mailroom/local-mcp.json`;
  return null;
}

export async function runMcpTask(job: Job, signal: AbortSignal, sup: McpSupervisor = sharedSupervisor()): Promise<unknown> {
  const a = job.args ?? {};
  // The daemon holds even if recheck were skipped: the contract decides which servers and tools exist for this job.
  if (job.task === "mcp_list") {
    const names = typeof a.server === "string" ? [a.server] : (job.contract.localMcp ?? []).map(s => s.server);
    const servers: unknown[] = [];
    for (const server of names) {
      if (!hasLocalMcpServer(job.contract, server)) throw new Error(`local MCP server “${server}” is not in the contract`);
      try {
        const all = await sup.listTools(server, signal);
        const tools = all.flatMap(t => {
          const c = findLocalMcpTool(job.contract, server, t.name);
          return c ? [{ name: t.name, description: t.description, readOnly: t.readOnly, inputSchema: t.inputSchema, requiresApproval: c.approval !== false }] : [];
        });
        servers.push({ server, tools });
      } catch (e) {
        if (signal.aborted) throw e;
        servers.push({ server, error: (e as Error).message });
      }
    }
    return { servers };
  }
  if (job.task === "mcp_call") {
    const server = a.server as string;
    const tool = a.tool as string;
    const c = findLocalMcpTool(job.contract, server, tool);
    if (!c) throw new Error(`tool “${String(tool)}” of local MCP server “${String(server)}” is not in the contract`);
    const found = (await sup.listTools(server, signal)).find(t => t.name === tool);
    if (!found) throw new Error(`local MCP server “${server}” has no tool “${tool}”`);
    // approval:false means "no owner approval needed", which the daemon honours only for a tool the server itself marks readOnly.
    if (c.approval === false && !found.readOnly) throw new Error(`tool “${tool}” is not annotated readOnly by “${server}”, so the contract cannot waive approval for it (remove approval:false)`);
    const r = await sup.callTool(server, tool, (a.args as Record<string, unknown>) ?? {}, { signal });
    return { server, tool, ...r };
  }
  throw new Error(`unknown task ${job.task}`);
}
