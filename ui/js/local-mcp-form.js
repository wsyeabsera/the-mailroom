// The contract editor's localMcp field, as plain text a person can type. No DOM, no network: pure, so tests import it.
// One server per line:  `server: tool, other-tool:auto, third:ask`
//   no suffix or :ask  -> the owner approves each call (approval missing / true)
//   :auto              -> runs without waiting, only if the laptop's server marks the tool read-only (approval: false)
// The Hub (shared/local-mcp.ts validateLocalMcp) is the authority and runs on save. The editor cannot import that TypeScript file in the
// browser, so `parseLocalMcp` takes the validator as an argument (the page passes none: the Hub's 422 `errors.localMcp` shows under the field;
// tests pass validateLocalMcp itself and prove the two agree).

/** The text for a contract's localMcp ([{server, tools:[{name, approval?}|"name"]}]). */
export function formatLocalMcp(localMcp) {
  if (!Array.isArray(localMcp)) return "";
  return localMcp.map((s) => {
    const tools = (Array.isArray(s && s.tools) ? s.tools : []).map((t) => {
      const name = typeof t === "string" ? t : t && t.name;
      const approval = t && typeof t === "object" ? t.approval : undefined;
      return approval === false ? name + ":auto" : approval === true ? name + ":ask" : name;
    });
    return `${s && s.server}: ${tools.join(", ")}`;
  }).join("\n");
}

/** Text -> { ok:true, localMcp } or { ok:false, error }. validate (optional) is validateLocalMcp: its verdict is used too. Never throws. */
export function parseLocalMcp(text, validate) {
  const localMcp = [];
  const lines = String(text == null ? "" : text).split("\n").map((l) => l.trim()).filter(Boolean);
  for (const [i, line] of lines.entries()) {
    const at = line.indexOf(":");
    if (at < 1) return { ok: false, error: `Line ${i + 1}: write “server: tool, tool”.` };
    const server = line.slice(0, at).trim();
    const tools = [];
    for (const raw of line.slice(at + 1).split(",").map((t) => t.trim()).filter(Boolean)) {
      const m = /^([^:]*)(?::([^:]*))?$/.exec(raw);
      const mode = m && m[2] !== undefined ? m[2].trim() : undefined;
      if (!m || (mode !== undefined && mode !== "auto" && mode !== "ask")) return { ok: false, error: `Line ${i + 1}: “${raw.slice(0, 40)}” must be a tool name, optionally followed by :auto or :ask.` };
      tools.push(mode === "auto" ? { name: m[1].trim(), approval: false } : mode === "ask" ? { name: m[1].trim(), approval: true } : { name: m[1].trim() });
    }
    localMcp.push({ server, tools });
  }
  if (typeof validate === "function") {
    const v = validate(localMcp);
    if (!v.ok) return { ok: false, error: v.error };
    return { ok: true, localMcp: v.servers };
  }
  return { ok: true, localMcp };
}

/** The tasks that need a localMcp list (kept in step with shared/local-mcp.ts LOCAL_MCP_TASKS). */
export const LOCAL_MCP_TASK_NAMES = ["mcp_list", "mcp_call"];

/** The editor's own early check before saving: mcp_* chosen but no servers. */
export function localMcpNeeded(tasks, localMcp) {
  return LOCAL_MCP_TASK_NAMES.some((t) => tasks.includes(t)) && (!Array.isArray(localMcp) || localMcp.length === 0)
    ? "Name at least one local MCP server (and its tools) for mcp_list or mcp_call."
    : null;
}
