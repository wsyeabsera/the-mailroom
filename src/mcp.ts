// The MCP admin channel: JSON-RPC 2.0 dispatch and tool definitions. Pure: no Worker imports, no I/O of its own.
// The Hub supplies `api` (the same internals the owner routes use) and `audit`; this module only decides who may call what.

export const SERVER_NAME = "the-mailroom";
export const SERVER_VERSION = "0.3.0";
export const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;
export const SCOPES = ["read", "write", "approve"] as const;
export type Scope = (typeof SCOPES)[number];

export const INSTRUCTIONS =
  "The Mailroom lets software ask the owner's laptop to do work, within contracts. Use the read tools first. Contracts say what a key may do; keys are the credentials clients use; parcels are the jobs. " +
  "Never approve a parcel without showing the owner what it will do. A key shown by mailroom_create_key exists in clear only once: hand it to the owner and do not store or repeat it anywhere else.";

/** A failure the caller should see in plain words (not found, validation, wrong state). Becomes an isError result. */
export class ToolError extends Error {
  details?: unknown;
  constructor(message: string, details?: unknown) {
    super(message);
    this.details = details;
  }
}

/** "name: Give it a short name. folders: Allow at least one folder." for the contract editor's field messages. */
export const formatFieldErrors = (errors: Record<string, string>): string => Object.entries(errors).map(([k, v]) => `${k}: ${v}`).join(" ");

export type ParcelFilter = { state?: string; label?: string; limit: number };
export type McpApi = {
  status(): Promise<unknown>;
  listParcels(a: ParcelFilter): Promise<unknown>;
  getParcel(id: string): Promise<unknown>;
  listKeys(): Promise<unknown>;
  getKey(id: string): Promise<unknown>;
  listContracts(): Promise<unknown>;
  getContract(id: string): Promise<unknown>;
  events(a: { after: number; limit: number }): Promise<unknown>;
  laptop(): Promise<unknown>;
  createContract(body: Record<string, unknown>): Promise<unknown>;
  updateContract(id: string, body: Record<string, unknown>): Promise<unknown>;
  createKey(a: { label: string; contract_id: string }): Promise<unknown>;
  revokeKey(id: string): Promise<unknown>;
  approveParcel(id: string): Promise<unknown>;
  declineParcel(id: string, reason?: string): Promise<unknown>;
};
export type AuditEntry = { tool: string; ok: boolean; target?: string };
export type McpContext = { scopes: readonly string[]; api: McpApi; audit?: (e: AuditEntry) => void | Promise<void> };

// ---- tiny JSON-Schema subset: enough to validate our own tool arguments with plain-words messages ----
type Schema = {
  type?: string | string[];
  description?: string;
  enum?: unknown[];
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  items?: Schema;
  default?: unknown;
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean;
};

const typeOf = (v: unknown): string => (v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v);
const matches = (v: unknown, t: string) => typeOf(v) === t || (t === "number" && typeof v === "number");

/** Returns a plain-words problem, or null when the value fits. `path` names the argument. */
export function checkSchema(v: unknown, s: Schema, path: string): string | null {
  const types = s.type === undefined ? null : Array.isArray(s.type) ? s.type : [s.type];
  if (types && !types.some((t) => matches(v, t))) return `"${path}" must be ${types.map((t) => (t === "integer" ? "a whole number" : t === "array" ? "a list" : `a ${t}`)).join(" or ")}.`;
  if (s.enum && !s.enum.includes(v)) return `"${path}" must be one of: ${s.enum.join(", ")}.`;
  if (typeof v === "string") {
    if (s.minLength !== undefined && v.length < s.minLength) return `"${path}" must be at least ${s.minLength} characters.`;
    if (s.maxLength !== undefined && v.length > s.maxLength) return `"${path}" must be at most ${s.maxLength} characters.`;
  }
  if (typeof v === "number") {
    if (s.minimum !== undefined && v < s.minimum) return `"${path}" must be at least ${s.minimum}.`;
    if (s.maximum !== undefined && v > s.maximum) return `"${path}" must be at most ${s.maximum}.`;
  }
  if (Array.isArray(v)) {
    if (s.minItems !== undefined && v.length < s.minItems) return `"${path}" needs at least ${s.minItems} item(s).`;
    if (s.maxItems !== undefined && v.length > s.maxItems) return `"${path}" can have at most ${s.maxItems} items.`;
    if (s.items) for (let i = 0; i < v.length; i++) { const p = checkSchema(v[i], s.items, `${path}[${i}]`); if (p) return p; }
  }
  if (v && typeof v === "object" && !Array.isArray(v) && s.properties) {
    const o = v as Record<string, unknown>;
    for (const r of s.required ?? []) if (o[r] === undefined) return `"${r}" is required.`;
    for (const [k, val] of Object.entries(o)) {
      const sub = s.properties[k];
      if (!sub) { if (s.additionalProperties === false) return `Unknown argument "${k}".`; continue; }
      if (val === undefined) continue;
      const p = checkSchema(val, sub, k);
      if (p) return p;
    }
  }
  return null;
}

// ---- tools ----
type Tool = {
  name: string;
  scope: Scope;
  description: string;
  inputSchema: Schema;
  /** Contract tools: field checking is left to validateContract so the messages match the editor. */
  soft?: boolean;
  /** The id this call acts on, for the audit trail. Never a secret. */
  target?: (args: Record<string, any>, result: any) => string | undefined;
  run(args: Record<string, any>, api: McpApi): Promise<unknown>;
};

const NONE: Schema = { type: "object", properties: {}, additionalProperties: false };
const idArg = (what: string, eg: string): Schema => ({ type: "object", properties: { id: { type: "string", minLength: 1, maxLength: 40, description: `The ${what} id, like ${eg}.` } }, required: ["id"], additionalProperties: false });
const CONTRACT_PROPS: Record<string, Schema> = {
  name: { type: "string", minLength: 1, maxLength: 60, description: "Short name for the contract (letters, numbers, spaces)." },
  folders: { type: "array", items: { type: "string", maxLength: 1000 }, minItems: 1, maxItems: 50, description: "Folders the key may touch, each starting with ~/ or / (never the whole home or root)." },
  tasks: { type: "array", items: { type: "string", enum: ["echo", "read_file", "write_file", "claude", "run"] }, minItems: 1, description: "Tasks the key may ask for: echo, read_file, write_file, claude, run." },
  commands: { type: "array", items: { type: "string", maxLength: 60 }, maxItems: 50, description: "Names of the laptop-registered commands the run task may start (required and non-empty when tasks includes run). Omit or [] otherwise." },
  claudeTools: { type: "array", items: { type: "string", maxLength: 100 }, minItems: 1, maxItems: 20, description: "Ceiling for the claude task: the tool names (exact match, like Read or Bash(git log:*)) a claude job may ask for; a job with no allowedTools gets exactly these. Default Read, Glob, Grep. Keep it read-only unless the owner says otherwise." },
  claudeMaxTurns: { type: "integer", minimum: 1, maximum: 50, description: "Ceiling for the claude task: the most turns a claude job may ask for; a job with no maxTurns gets this many. Default 10." },
  callbackUrls: { type: "array", items: { type: "string", maxLength: 500 }, maxItems: 20, description: "Optional. https URL prefixes, each ending in /, that a job's callback_url may start with; the Hub POSTs a signed result there when the job ends. No IP addresses or local names. Omit or [] for none." },
  dailyLimit: { type: "integer", minimum: 1, maximum: 100000, description: "Whole parcels per UTC day, 1 to 100000." },
  expires: { type: ["string", "null"], description: "Date like 2026-12-31 after which the contract stops working, or null for never." },
  approval: { type: "array", items: { type: "string" }, description: "Tasks (a subset of tasks) that wait for the owner before they run. Use [] for none." },
};
const CONTRACT_REQUIRED = ["name", "folders", "tasks", "dailyLimit", "approval"];
const idOf = (a: Record<string, any>) => (typeof a.id === "string" ? a.id : undefined);

export const TOOLS: Tool[] = [
  {
    name: "mailroom_status", scope: "read", inputSchema: NONE,
    description: "Overview of The Mailroom: whether the owner's laptop is connected, parcel counts by state (queued, waiting_approval, running, done, refused, failed), the parcels waiting for the owner's approval (needs_you), the latest events and the approval count. Start here. Returns one JSON object.",
    run: (_a, api) => api.status(),
  },
  {
    name: "mailroom_list_parcels", scope: "read",
    description: "List parcels (jobs that clients submitted), newest first. Optionally filter by state. Returns an array of parcels, each with id, key_id, task, args, state, reason, result and timestamps. Use mailroom_get_parcel for one parcel's full story.",
    inputSchema: { type: "object", properties: { state: { type: "string", enum: ["queued", "waiting_approval", "running", "done", "failed", "refused", "expired", "cancelled"], description: "Only parcels in this state." }, label: { type: "string", maxLength: 60, description: "Only parcels the client labelled exactly this (for example \"test\")." }, limit: { type: "integer", minimum: 1, maximum: 200, description: "How many to return, 1 to 200 (default 50)." } }, additionalProperties: false },
    run: (a, api) => api.listParcels({ state: a.state, ...(a.label ? { label: a.label } : {}), limit: a.limit ?? 50 }),
  },
  {
    name: "mailroom_get_parcel", scope: "read", inputSchema: idArg("parcel", "p_1001"),
    description: "Get one parcel with its timeline of events, a fresh contract check (what the contract says about this parcel now) and the key that sent it. Use this to see exactly what a parcel will do before the owner decides on it.",
    run: (a, api) => api.getParcel(a.id),
  },
  {
    name: "mailroom_list_keys", scope: "read", inputSchema: NONE,
    description: "List client keys (the credentials software uses to submit parcels) with their contract, creation and last-used times and whether they are revoked. Never includes the secret key itself, only a short display prefix.",
    run: (_a, api) => api.listKeys(),
  },
  {
    name: "mailroom_get_key", scope: "read", inputSchema: idArg("key", "k_1000"),
    description: "Get one client key with its contract and its 10 most recent parcels. Never includes the secret.",
    run: (a, api) => api.getKey(a.id),
  },
  {
    name: "mailroom_list_contracts", scope: "read", inputSchema: NONE,
    description: "List contracts. A contract says which folders, tasks, daily limit, expiry and approval rules apply to the keys that use it. Each item also has version and used_by (how many live keys use it).",
    run: (_a, api) => api.listContracts(),
  },
  {
    name: "mailroom_get_contract", scope: "read", inputSchema: idArg("contract", "c_1000"),
    description: "Get one contract: name, folders, tasks, dailyLimit, expires, approval, version and used_by.",
    run: (a, api) => api.getContract(a.id),
  },
  {
    name: "mailroom_events", scope: "read",
    description: "Read the append-only event log (everything that happened: parcels, keys, contracts, laptop, tokens and MCP calls). Returns {events, last_seq}. Pass after=<last_seq you saw> to read only newer events.",
    inputSchema: { type: "object", properties: { after: { type: "integer", minimum: 0, description: "Only events with a seq greater than this (default 0)." }, limit: { type: "integer", minimum: 1, maximum: 500, description: "How many events, 1 to 500 (default 200)." } }, additionalProperties: false },
    run: (a, api) => api.events({ after: a.after ?? 0, limit: a.limit ?? 200 }),
  },
  {
    name: "mailroom_laptop", scope: "read", inputSchema: NONE,
    description: "Is the owner's laptop connected, when was it last seen, and which parcels are queued waiting for it. Returns {connected, last_seen, last_seq, rotated_at, credential_hint, queue}. It never reveals the laptop credential.",
    run: (_a, api) => api.laptop(),
  },
  {
    name: "mailroom_create_contract", scope: "write", soft: true,
    description: "Create a contract: the rules a key works under. Returns the saved contract, or an error listing what to fix, field by field. Folders must start with ~/ or / and may never be the whole home or root. Keep contracts narrow: only the folders and tasks the client really needs, and put risky tasks (write_file, claude) under approval. Ask the owner before creating a broad contract.",
    inputSchema: { type: "object", properties: CONTRACT_PROPS, required: CONTRACT_REQUIRED, additionalProperties: false },
    target: (_a, r) => r?.id,
    run: (a, api) => api.createContract(a),
  },
  {
    name: "mailroom_update_contract", scope: "write", soft: true,
    description: "Replace a contract's rules (send all fields, not just changes). The version goes up, the new rules apply to the next parcel, and parcels already queued are checked against them again just before they are sent to the laptop (one the new rules do not allow is refused then). Returns the saved contract or what to fix. Never widen a contract (more folders, more tasks, fewer approvals, higher limit) without the owner's say-so.",
    inputSchema: { type: "object", properties: { id: { type: "string", minLength: 1, maxLength: 40, description: "The contract id, like c_1000." }, ...CONTRACT_PROPS }, required: ["id", ...CONTRACT_REQUIRED], additionalProperties: false },
    target: idOf,
    run: (a, api) => { const { id, ...body } = a; return api.updateContract(id, body); },
  },
  {
    name: "mailroom_create_key", scope: "write",
    description: "Create a client key under an existing contract. Returns {id, label, key}. IMPORTANT: the key (starting mr_live_) is shown only once, in this result; The Mailroom keeps only a hash and cannot show it again. Hand it to the owner in your reply to them and never store it, write it to a file, log it, or repeat it anywhere else. If it is lost, revoke the key and make a new one.",
    inputSchema: { type: "object", properties: { label: { type: "string", minLength: 1, maxLength: 60, description: "Who or what will use this key, 1 to 60 characters." }, contract_id: { type: "string", minLength: 1, maxLength: 40, description: "The contract the key works under, like c_1000." } }, required: ["label", "contract_id"], additionalProperties: false },
    target: (_a, r) => r?.id,
    run: (a, api) => api.createKey({ label: a.label, contract_id: a.contract_id }),
  },
  {
    name: "mailroom_revoke_key", scope: "write", inputSchema: idArg("key", "k_1000"),
    description: "Revoke a client key at once. It stops working on its next request, and its queued, waiting and running parcels are cancelled (a running one is cancelled on the laptop). This cannot be undone. Returns {id, revoked_at, cancelled}. Confirm with the owner first unless they asked for it.",
    target: idOf,
    run: (a, api) => api.revokeKey(a.id),
  },
  {
    name: "mailroom_approve_parcel", scope: "approve", inputSchema: idArg("parcel", "p_1001"),
    description: "Approve a parcel that is waiting_approval so it can run on the owner's laptop. The contract is re-checked first; if it no longer allows the parcel it is refused instead. FIRST call mailroom_get_parcel and show the owner what the parcel will do (task and arguments) and get their yes; never approve on your own say-so. Returns {id, state}.",
    target: idOf,
    run: (a, api) => api.approveParcel(a.id),
  },
  {
    name: "mailroom_decline_parcel", scope: "approve",
    description: "Decline a parcel that is waiting_approval; it becomes refused and never runs. Show the owner what the parcel would have done and why you suggest declining before you do it. Optionally give a short reason for the record. Returns {id, state:\"refused\"}.",
    inputSchema: { type: "object", properties: { id: { type: "string", minLength: 1, maxLength: 40, description: "The parcel id, like p_1001." }, reason: { type: "string", maxLength: 200, description: "Short reason for the record." } }, required: ["id"], additionalProperties: false },
    target: idOf,
    run: (a, api) => api.declineParcel(a.id, a.reason),
  },
];

/** Does a token with these scopes hold `need`? write and approve each include read. */
export const hasScope = (scopes: readonly string[], need: Scope): boolean => scopes.includes(need) || (need === "read" && (scopes.includes("write") || scopes.includes("approve")));

export const toolsFor = (scopes: readonly string[]) => TOOLS.filter((t) => hasScope(scopes, t.scope));

// ---- JSON-RPC ----
export type RpcResponse = { jsonrpc: "2.0"; id: unknown; result?: unknown; error?: { code: number; message: string; data?: unknown } };
const rpcErr = (id: unknown, code: number, message: string): RpcResponse => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
const rpcOk = (id: unknown, result: unknown): RpcResponse => ({ jsonrpc: "2.0", id, result });

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const toolResult = (data: unknown, isError = false) => {
  const text = typeof data === "string" ? data : JSON.stringify(data);
  const out: Record<string, unknown> = { content: [{ type: "text", text }], isError };
  if (typeof data !== "string") out.structuredContent = Array.isArray(data) ? { items: data } : data;
  return out;
};
const failure = (message: string, details?: unknown) => ({ content: [{ type: "text", text: message }], structuredContent: { error: message, ...(details === undefined ? {} : { details }) }, isError: true });

async function audit(ctx: McpContext, entry: AuditEntry) {
  try { await ctx.audit?.(entry); } catch { /* an audit hiccup must not change the tool's outcome */ }
}

async function callTool(params: unknown, ctx: McpContext, id: unknown): Promise<RpcResponse> {
  if (!isObj(params) || typeof params.name !== "string") return rpcErr(id, -32602, "Invalid params: tools/call needs a tool name.");
  const tool = TOOLS.find((t) => t.name === params.name);
  if (!tool) return rpcErr(id, -32602, `Unknown tool: ${params.name}`);
  if (params.arguments !== undefined && !isObj(params.arguments)) return rpcErr(id, -32602, "Invalid params: arguments must be an object.");
  const args = (params.arguments ?? {}) as Record<string, any>;
  const logged = tool.scope !== "read";
  const target = typeof args.id === "string" ? args.id.slice(0, 40) : undefined;

  if (!hasScope(ctx.scopes, tool.scope)) {
    if (logged) await audit(ctx, { tool: tool.name, ok: false, target });
    return rpcOk(id, failure(`This token cannot do that (needs the ${tool.scope} scope).`));
  }
  // Contract tools leave field checking to validateContract (the Hub runs it), so the messages match the contract editor.
  const problem = tool.soft
    ? Object.keys(args).find((k) => !(k in (tool.inputSchema.properties ?? {}))) !== undefined
      ? `Unknown argument "${Object.keys(args).find((k) => !(k in (tool.inputSchema.properties ?? {})))}".`
      : tool.inputSchema.properties?.id && (typeof args.id !== "string" || !args.id) ? '"id" is required and must be a string.' : null
    : checkSchema(args, tool.inputSchema, "arguments");
  if (problem) {
    if (logged) await audit(ctx, { tool: tool.name, ok: false, target });
    return rpcOk(id, failure(problem.replace(/^"arguments" /, "The arguments ")));
  }
  try {
    const data = await tool.run(args, ctx.api);
    if (logged) await audit(ctx, { tool: tool.name, ok: true, target: tool.target?.(args, data) ?? target });
    return rpcOk(id, toolResult(data));
  } catch (e) {
    if (logged) await audit(ctx, { tool: tool.name, ok: false, target });
    if (e instanceof ToolError) return rpcOk(id, failure(e.message, e.details));
    return rpcErr(id, -32603, "Internal error.");
  }
}

/**
 * Handles one parsed JSON-RPC message. Returns the response to send, or null for a notification (HTTP 202, no body).
 * A batch (array) is rejected with -32600.
 */
export async function handleMcp(message: unknown, ctx: McpContext): Promise<RpcResponse | null> {
  if (Array.isArray(message)) return rpcErr(null, -32600, "Invalid request: batches are not supported, send one message per request.");
  if (!isObj(message) || message.jsonrpc !== "2.0") return rpcErr(isObj(message) ? message.id : null, -32600, "Invalid request.");
  const hasId = "id" in message && message.id !== undefined;
  const id = message.id;
  if (hasId && typeof id !== "string" && typeof id !== "number") return rpcErr(null, -32600, "Invalid request: id must be a string or number.");
  if (typeof message.method !== "string") return "result" in message || "error" in message ? null : rpcErr(hasId ? id : null, -32600, "Invalid request: missing method.");
  if (!hasId) return null; // a notification: nothing to answer, whatever it says
  const { method, params } = message;

  try {
    switch (method) {
      case "initialize": {
        const asked = isObj(params) ? params.protocolVersion : undefined;
        const version = (PROTOCOL_VERSIONS as readonly unknown[]).includes(asked) ? (asked as string) : PROTOCOL_VERSIONS[0];
        return rpcOk(id, { protocolVersion: version, capabilities: { tools: { listChanged: false } }, serverInfo: { name: SERVER_NAME, version: SERVER_VERSION }, instructions: INSTRUCTIONS });
      }
      case "ping":
        return rpcOk(id, {});
      case "tools/list":
        return rpcOk(id, { tools: toolsFor(ctx.scopes).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: { readOnlyHint: t.scope === "read", destructiveHint: t.name === "mailroom_revoke_key" } })) });
      case "tools/call":
        return await callTool(params, ctx, id);
      default:
        return rpcErr(id, -32601, `Method not found: ${method}`);
    }
  } catch {
    return rpcErr(id, -32603, "Internal error.");
  }
}

/** Parses a request body and handles it. Bad JSON is -32700. */
export async function handleMcpText(text: string, ctx: McpContext): Promise<RpcResponse | null> {
  let msg: unknown;
  try { msg = JSON.parse(text); } catch { return rpcErr(null, -32700, "Parse error: the body is not valid JSON."); }
  return handleMcp(msg, ctx);
}
