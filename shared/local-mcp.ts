// Local MCP servers in a contract. Pure: no I/O, no clock. Used by the Hub (validateContract, check) and by the daemon (check again).
// A contract names a server and the tools of it a key may use. It never carries a command, args, env or cwd: those live only on the laptop
// (daemon/local-mcp.ts, ~/.mailroom/local-mcp.json), so the cloud can pick a name but never what runs.
// Names are matched by exact, case-sensitive string equality against strict ASCII patterns: no trimming, no Unicode normalisation, no wildcards.

export const LOCAL_MCP_TASKS = ["mcp_list", "mcp_call"] as const;
export const LOCAL_MCP_SERVER_RE = /^[A-Za-z0-9-]{1,40}$/;
export const LOCAL_MCP_TOOL_RE = /^[A-Za-z0-9_.-]{1,64}$/;
export const LOCAL_MCP_MAX_SERVERS = 10;
export const LOCAL_MCP_MAX_TOOLS = 50;
/** Largest `args` object an mcp_call job may carry, as JSON. */
export const LOCAL_MCP_MAX_ARGS_BYTES = 64 * 1024;
/** The only keys an mcp_call job may carry. Never a command, argv, env, cwd or timeout: the laptop decides those. */
export const MCP_CALL_ARG_KEYS = ["server", "tool", "args"] as const;
export const MCP_LIST_ARG_KEYS = ["server"] as const;

/** approval: true = always waits for the owner; false = never waits (the daemon honours it only for a tool the server annotates readOnly); missing = waits. */
export type LocalMcpTool = { name: string; approval?: boolean };
export type LocalMcpServer = { server: string; tools: LocalMcpTool[] };

/** A value as text for a refusal message; never throws (an object can have a hostile toString). */
const show = (v: unknown): string => { try { return typeof v === "string" ? v.slice(0, 80) : JSON.stringify(v)?.slice(0, 80) ?? String(typeof v); } catch { return typeof v; } };
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Validates a contract's localMcp field (editor or API payload). Strings in `tools` are shorthand for {name}. Never throws. */
export function validateLocalMcp(raw: unknown): { ok: true; servers: LocalMcpServer[] } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, servers: [] };
  if (!Array.isArray(raw)) return { ok: false, error: "localMcp must be a list of {server, tools}." };
  if (raw.length > LOCAL_MCP_MAX_SERVERS) return { ok: false, error: `Allow at most ${LOCAL_MCP_MAX_SERVERS} local MCP servers.` };
  const servers: LocalMcpServer[] = [];
  for (const s of raw) {
    if (!isObj(s)) return { ok: false, error: "Each local MCP server must be {server, tools}." };
    const extra = Object.keys(s).filter(k => k !== "server" && k !== "tools");
    if (extra.length) return { ok: false, error: `Local MCP server entries take only server and tools (not ${extra.join(", ")}): the command lives on the laptop.` };
    if (typeof s.server !== "string" || !LOCAL_MCP_SERVER_RE.test(s.server)) return { ok: false, error: `“${show(s.server)}” is not a server name (letters, digits and dashes, up to 40).` };
    if (servers.some(x => x.server === s.server)) return { ok: false, error: `Server “${s.server}” is listed twice.` };
    if (!Array.isArray(s.tools) || s.tools.length === 0 || s.tools.length > LOCAL_MCP_MAX_TOOLS) return { ok: false, error: `Server “${s.server}” needs 1 to ${LOCAL_MCP_MAX_TOOLS} tools.` };
    const tools: LocalMcpTool[] = [];
    for (const t of s.tools) {
      const o = typeof t === "string" ? { name: t } : t;
      if (!isObj(o)) return { ok: false, error: `Tools of “${s.server}” must be names or {name, approval}.` };
      const bad = Object.keys(o).filter(k => k !== "name" && k !== "approval");
      if (bad.length) return { ok: false, error: `A tool entry takes only name and approval (not ${bad.join(", ")}).` };
      if (typeof o.name !== "string" || !LOCAL_MCP_TOOL_RE.test(o.name)) return { ok: false, error: `“${show(o.name)}” is not a tool name (ASCII letters, digits, _ . - up to 64).` };
      if (o.approval !== undefined && typeof o.approval !== "boolean") return { ok: false, error: `approval on “${o.name}” must be true or false.` };
      if (tools.some(x => x.name === o.name)) return { ok: false, error: `Tool “${o.name}” is listed twice on “${s.server}”.` };
      tools.push({ name: o.name, ...(o.approval !== undefined ? { approval: o.approval } : {}) });
    }
    servers.push({ server: s.server, tools });
  }
  return { ok: true, servers };
}

/** The contract's entry for a tool: exact match only (no case folding, no Unicode normalisation). Own properties only. */
export function findLocalMcpTool(contract: { localMcp?: LocalMcpServer[] }, server: unknown, tool: unknown): LocalMcpTool | null {
  if (typeof server !== "string" || typeof tool !== "string" || !Array.isArray(contract.localMcp)) return null;
  const s = contract.localMcp.find(x => x?.server === server);
  return s && Array.isArray(s.tools) ? (s.tools.find(t => t?.name === tool) ?? null) : null;
}

export const hasLocalMcpServer = (contract: { localMcp?: LocalMcpServer[] }, server: unknown): boolean =>
  typeof server === "string" && Array.isArray(contract.localMcp) && contract.localMcp.some(x => x?.server === server);

/** The contract's rule for an mcp_list or mcp_call job: a refuse reason, or whether this job waits for the owner. Never throws. */
export function checkLocalMcp(contract: { localMcp?: LocalMcpServer[] }, task: string, args: unknown): { refuse: string } | { approve: boolean } {
  const a = isObj(args) ? args : {};
  const allowed: readonly string[] = task === "mcp_call" ? MCP_CALL_ARG_KEYS : MCP_LIST_ARG_KEYS;
  const extra = Object.keys(a).filter(k => !allowed.includes(k));
  if (extra.length) return { refuse: `${task} takes only ${allowed.join(", ")} (not ${extra.join(", ")}); the laptop decides what runs` };
  if (task === "mcp_list") {
    if (a.server !== undefined && !hasLocalMcpServer(contract, a.server)) return { refuse: `local MCP server “${show(a.server)}” is not in the contract` };
    if (a.server === undefined && !(contract.localMcp ?? []).length) return { refuse: "the contract allows no local MCP server" };
    return { approve: false };
  }
  if (!hasLocalMcpServer(contract, a.server)) return { refuse: `local MCP server “${show(a.server)}” is not in the contract` };
  const t = findLocalMcpTool(contract, a.server, a.tool);
  if (!t) return { refuse: `tool “${show(a.tool)}” of local MCP server “${show(a.server)}” is not in the contract` };
  if (a.args !== undefined) {
    if (!isObj(a.args)) return { refuse: "mcp_call args must be an object" };
    let size = Infinity;
    try { size = Buffer.byteLength(JSON.stringify(a.args)); } catch { /* not JSON */ }
    if (size > LOCAL_MCP_MAX_ARGS_BYTES) return { refuse: `mcp_call args are bigger than ${LOCAL_MCP_MAX_ARGS_BYTES / 1024} KB or not JSON` };
  }
  return { approve: t.approval !== false };
}
