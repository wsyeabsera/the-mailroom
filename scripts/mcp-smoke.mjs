// MCP admin channel smoke test against a running `wrangler dev`. Usage: node scripts/mcp-smoke.mjs [baseUrl]
import { readFileSync } from "node:fs";
import WebSocket from "ws";

const BASE = (process.argv[2] ?? "http://localhost:8787").replace(/\/$/, "");
const vars = Object.fromEntries(readFileSync(new URL("../.dev.vars", import.meta.url), "utf8").split("\n").filter((l) => l.includes("=") && !l.startsWith("#")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
let cookie = "";
let n = 0;
const ok = (cond, msg) => { if (!cond) throw new Error(`FAIL: ${msg}`); console.log(`ok ${++n} ${msg}`); };

async function call(method, path, { body, bearer, auth = true, headers = {}, raw } = {}) {
  const h = { ...headers };
  if (body !== undefined || raw !== undefined) h["content-type"] = "application/json";
  if (bearer) h.Authorization = `Bearer ${bearer}`;
  if (auth && cookie) h.Cookie = cookie;
  const res = await fetch(BASE + path, { method, headers: h, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)), redirect: "manual" });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : undefined; } catch { data = text; }
  return { status: res.status, data, res, text };
}
let rid = 0;
const rpc = (token, method, params, extra) => call("POST", "/mcp", { bearer: token, auth: false, body: { jsonrpc: "2.0", id: ++rid, method, params }, ...extra });
const tool = async (token, name, args = {}) => { const r = await rpc(token, "tools/call", { name, arguments: args }); if (r.status !== 200 || !r.data?.result) throw new Error(`FAIL: ${name} -> ${r.status} ${r.text.slice(0, 200)}`); return r.data.result; };
const toolNames = async (token) => (await rpc(token, "tools/list")).data.result.tools.map((t) => t.name);

// owner session
let r = await call("POST", "/admin/login", { body: { password: vars.OWNER_PASSWORD }, auth: false });
ok(r.status === 204, "owner login");
cookie = r.res.headers.get("set-cookie").split(";")[0];

// tokens
r = await call("POST", "/admin/tokens", { body: { label: "", scopes: ["read"] } });
ok(r.status === 422 && r.data.errors.label, "empty token label is 422");
r = await call("POST", "/admin/tokens", { body: { label: "x", scopes: [] } });
ok(r.status === 422 && r.data.errors.scopes, "empty scopes is 422");
r = await call("POST", "/admin/tokens", { body: { label: "x", scopes: ["admin"] } });
ok(r.status === 422 && r.data.errors.scopes, "unknown scope is 422");
const mk = async (label, scopes) => { const t = await call("POST", "/admin/tokens", { body: { label, scopes } }); if (t.status !== 201) throw new Error("token create failed " + t.status); return t.data; };
const T_read = await mk("smoke read", ["read"]);
const T_write = await mk("smoke write", ["write"]);
const T_approve = await mk("smoke approve", ["approve"]);
ok(/^mra_[0-9A-Za-z]{32}$/.test(T_read.token), "token shape");
ok(JSON.stringify(T_write.scopes) === '["read","write"]' && JSON.stringify(T_approve.scopes) === '["read","approve"]', "read is added for write and approve");
r = await call("GET", "/admin/tokens");
ok(r.status === 200 && r.data.length >= 3 && !JSON.stringify(r.data).includes(T_read.token) && r.data.find((t) => t.id === T_read.id).prefix === T_read.token.slice(0, 12), "token list shows the prefix only");

// protocol
r = await rpc(T_read.token, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "smoke", version: "1" } });
ok(r.status === 200 && r.data.result.protocolVersion === "2025-03-26" && r.data.result.serverInfo.name === "the-mailroom", "initialize negotiates the version");
r = await call("POST", "/mcp", { bearer: T_read.token, auth: false, body: { jsonrpc: "2.0", method: "notifications/initialized" } });
ok(r.status === 202 && r.text === "", "notification is 202 with no body");
r = await rpc(T_read.token, "ping");
ok(r.status === 200 && JSON.stringify(r.data.result) === "{}", "ping");
r = await call("POST", "/mcp", { bearer: T_read.token, auth: false, raw: "{nope" });
ok(r.status === 200 && r.data.error.code === -32700, "bad JSON is -32700");
r = await call("POST", "/mcp", { bearer: T_read.token, auth: false, body: [{ jsonrpc: "2.0", id: 1, method: "ping" }] });
ok(r.data.error.code === -32600, "batch is -32600");
r = await rpc(T_read.token, "nope/nope");
ok(r.data.error.code === -32601, "unknown method is -32601");
const nRead = await toolNames(T_read.token), nWrite = await toolNames(T_write.token), nAppr = await toolNames(T_approve.token);
ok(nRead.length === 9 && nWrite.length === 13 && nAppr.length === 11, `tools/list differs per scope (${nRead.length}/${nWrite.length}/${nAppr.length})`);
ok(!nRead.includes("mailroom_create_key") && nWrite.includes("mailroom_create_key") && !nWrite.includes("mailroom_approve_parcel") && nAppr.includes("mailroom_approve_parcel"), "the right tools per scope");

// setup through the owner API so the read token has something to see
r = await call("POST", "/admin/contracts", { body: { name: "Smoke owner contract", folders: ["~/mcp-smoke"], tasks: ["echo", "write_file"], dailyLimit: 50, expires: null, approval: ["write_file"] } });
const ownerCid = r.data.id;
r = await call("POST", "/admin/keys", { body: { label: "Smoke client", contract_id: ownerCid } });
const clientKey = r.data.key, clientKid = r.data.id;

// read token
let res = await tool(T_read.token, "mailroom_list_keys");
ok(res.isError === false && res.structuredContent.items.some((k) => k.id === clientKid) && !res.content[0].text.includes(clientKey), "read token lists keys, no secret");
res = await tool(T_read.token, "mailroom_list_parcels", { limit: 5 });
ok(res.isError === false && Array.isArray(res.structuredContent.items), "read token lists parcels");
res = await tool(T_read.token, "mailroom_status");
ok(res.isError === false && typeof res.structuredContent.approvals === "number", "status");
res = await tool(T_read.token, "mailroom_get_key", { id: "k_zzzz" });
ok(res.isError === true && /not found/.test(res.content[0].text), "unknown key is an isError result");
res = await tool(T_read.token, "mailroom_create_key", { label: "nope", contract_id: ownerCid });
ok(res.isError === true && /needs the write scope/.test(res.content[0].text), "read token cannot create a key");
r = await rpc(T_read.token, "tools/call", { name: "mailroom_nope", arguments: {} });
ok(r.data.error.code === -32602, "unknown tool is -32602");

// write token
res = await tool(T_write.token, "mailroom_create_contract", { name: "", folders: ["/"], tasks: ["nope"], dailyLimit: 0, approval: [] });
ok(res.isError === true && /name:/.test(res.content[0].text) && res.structuredContent.details.folders, "contract validation errors come back as field messages");
res = await tool(T_write.token, "mailroom_create_contract", { name: "MCP made", folders: ["~/mcp-smoke"], tasks: ["echo"], dailyLimit: 10, approval: [] });
ok(res.isError === false && res.structuredContent.id && res.structuredContent.version === 1, "write token creates a contract");
const mcid = res.structuredContent.id;
res = await tool(T_write.token, "mailroom_update_contract", { id: mcid, name: "MCP made", folders: ["~/mcp-smoke"], tasks: ["echo", "read_file"], dailyLimit: 10, approval: [] });
ok(res.isError === false && res.structuredContent.version === 2, "write token updates a contract");
res = await tool(T_write.token, "mailroom_create_key", { label: "MCP key", contract_id: mcid });
ok(res.isError === false && /^mr_live_[0-9A-Za-z]{32}$/.test(res.structuredContent.key), "write token creates a key (shown once)");
const mkey = res.structuredContent.key, mkid = res.structuredContent.id;
r = await call("POST", "/api/jobs", { bearer: mkey, auth: false, body: { task: "echo", args: { text: "hi" } } });
ok(r.status === 202, "the MCP-made key works on /api/jobs");
res = await tool(T_write.token, "mailroom_revoke_key", { id: mkid });
ok(res.isError === false && res.structuredContent.cancelled === 1, "write token revokes the key and its queued parcel is cancelled");
r = await call("POST", "/api/jobs", { bearer: mkey, auth: false, body: { task: "echo", args: { text: "hi" } } });
ok(r.status === 401, "the revoked key is dead");
res = await tool(T_write.token, "mailroom_approve_parcel", { id: "p_1000" });
ok(res.isError === true && /needs the approve scope/.test(res.content[0].text), "write-only token cannot approve");

// approval
r = await call("POST", "/api/jobs", { bearer: clientKey, auth: false, body: { task: "write_file", args: { path: "~/mcp-smoke/a.txt", content: "hello" } } });
ok(r.status === 202 && r.data.state === "waiting_approval", "client job waits for approval");
const pid = r.data.id;
res = await tool(T_read.token, "mailroom_list_parcels", { state: "waiting_approval" });
ok(res.structuredContent.items.some((p) => p.id === pid), "the waiting parcel is listed via MCP");
res = await tool(T_read.token, "mailroom_get_parcel", { id: pid });
ok(res.structuredContent.contract_check.verdict === "approve" && res.structuredContent.timeline.length >= 1, "get_parcel has contract_check and timeline");
res = await tool(T_write.token, "mailroom_approve_parcel", { id: pid });
ok(res.isError === true, "still refused for the write token");
res = await tool(T_approve.token, "mailroom_approve_parcel", { id: pid });
ok(res.isError === false && res.structuredContent.state === "queued", "approve token approves: parcel is queued");
res = await tool(T_approve.token, "mailroom_approve_parcel", { id: pid });
ok(res.isError === true && /cannot be approved/.test(res.content[0].text), "approving twice is an isError result");
r = await call("POST", "/api/jobs", { bearer: clientKey, auth: false, body: { task: "write_file", args: { path: "~/mcp-smoke/b.txt", content: "x" } } });
res = await tool(T_approve.token, "mailroom_decline_parcel", { id: r.data.id, reason: "smoke" });
ok(res.isError === false && res.structuredContent.state === "refused", "approve token declines");

// audit
r = await call("GET", "/admin/events?after=0&limit=1000");
const calls = r.data.events.filter((e) => e.kind === "mcp.call");
ok(calls.length >= 8 && calls.some((e) => e.payload.tool === "mailroom_create_key" && e.payload.ok === true && e.payload.token_id === T_write.id && e.payload.label === "smoke write") && calls.some((e) => e.payload.ok === false), "mcp.call events recorded (ok and failed)");
ok(!calls.some((e) => e.payload.tool.startsWith("mailroom_list") || e.payload.tool === "mailroom_status"), "reads are not audited");
const dump = JSON.stringify(r.data.events);
for (const secret of [T_read.token, T_write.token, T_approve.token, clientKey, mkey]) ok(!dump.includes(secret), "no secret in the event log");
ok(r.data.events.some((e) => e.kind === "token.created") , "token.created event");

// wrong credentials on /mcp
const cred = (await call("POST", "/admin/laptop/rotate", { body: {} })).data.credential;
r = await call("POST", "/mcp", { bearer: clientKey, auth: false, body: { jsonrpc: "2.0", id: 1, method: "ping" } });
ok(r.status === 401 && r.res.headers.get("www-authenticate") === "Bearer", "a client key is 401 on /mcp");
r = await call("POST", "/mcp", { bearer: cred, auth: false, body: { jsonrpc: "2.0", id: 1, method: "ping" } });
ok(r.status === 401, "a daemon credential is 401 on /mcp");
r = await call("POST", "/mcp", { auth: true, body: { jsonrpc: "2.0", id: 1, method: "ping" } });
ok(r.status === 401, "the owner cookie alone is 401 on /mcp");
r = await call("POST", "/mcp", { auth: false, body: { jsonrpc: "2.0", id: 1, method: "ping" } });
ok(r.status === 401, "no credential is 401 on /mcp");
r = await call("POST", "/mcp", { bearer: "mra_" + "a".repeat(32), auth: false, body: { jsonrpc: "2.0", id: 1, method: "ping" } });
ok(r.status === 401, "an unknown mra_ token is 401");
r = await call("GET", "/admin/state", { bearer: T_write.token, auth: false });
ok(r.status === 401, "an mra_ token is rejected on /admin/state");
r = await call("POST", "/admin/tokens", { bearer: T_write.token, auth: false, body: { label: "x", scopes: ["read"] } });
ok(r.status === 401, "an mra_ token cannot create tokens");
r = await call("POST", "/api/jobs", { bearer: T_write.token, auth: false, body: { task: "echo", args: { text: "x" } } });
ok(r.status === 401, "an mra_ token is not a client key");
const wsStatus = await new Promise((res) => { const w = new WebSocket(BASE.replace(/^http/, "ws") + "/daemon", { headers: { Authorization: `Bearer ${T_write.token}` } }); w.on("unexpected-response", (_q, x) => res(x.statusCode)); w.on("error", () => {}); w.on("open", () => { w.close(); res(101); }); });
ok(wsStatus === 401, "an mra_ token is not a daemon credential");

// transport rules
r = await call("POST", "/mcp", { bearer: T_read.token, auth: false, headers: { Origin: "https://evil.example" }, body: { jsonrpc: "2.0", id: 1, method: "ping" } });
ok(r.status === 403, "a foreign Origin is 403");
r = await call("GET", "/mcp", { bearer: T_read.token, auth: false });
ok(r.status === 405, "GET /mcp is 405");
r = await call("DELETE", "/mcp", { bearer: T_read.token, auth: false });
ok(r.status === 405, "DELETE /mcp is 405");
r = await call("POST", "/mcp", { bearer: T_read.token, auth: false, raw: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", pad: "x".repeat(70 * 1024) }) });
ok(r.status === 413, "a body over 64 KB is 413");

// revoke a token: next request fails
r = await call("POST", `/admin/tokens/${T_read.id}/revoke`, { body: {} });
ok(r.status === 200 && r.data.id === T_read.id && r.data.revoked_at, "token revoked by the owner");
r = await rpc(T_read.token, "ping");
ok(r.status === 401, "a revoked token gets 401 on its next request");
r = await call("GET", "/admin/tokens");
ok(r.data.find((t) => t.id === T_read.id).revoked_at && r.data.find((t) => t.id === T_write.id).last_used_at, "list shows revoked_at and last_used_at");
r = await call("GET", "/admin/events?after=0&limit=1000");
ok(r.data.events.some((e) => e.kind === "token.revoked" && e.payload.token_id === T_read.id), "token.revoked event");

// rate limit (last: it spends the write token's budget)
let limited = 0;
for (let i = 0; i < 130; i++) { const x = await rpc(T_write.token, "ping"); if (x.status === 429) limited++; }
ok(limited > 0, `more than 120 requests a minute is 429 (${limited} refused)`);

console.log(`\nMCP SMOKE PASSED (${n} checks)`);
process.exit(0);
