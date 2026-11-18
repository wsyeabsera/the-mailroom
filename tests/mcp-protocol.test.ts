import test from "node:test";
import assert from "node:assert/strict";
import { handleMcp, handleMcpText, TOOLS, type McpApi, type McpContext } from "../src/mcp.ts";

const api = new Proxy({}, { get: () => async () => ({}) }) as McpApi;
const ctx = (scopes: string[]): McpContext => ({ scopes, api });
const rpc = (method: string, params?: unknown, id: unknown = 1) => ({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
const names = async (scopes: string[]) => ((await handleMcp(rpc("tools/list"), ctx(scopes)))!.result as any).tools.map((t: any) => t.name as string);

test("initialize answers a supported version with itself", async () => {
  for (const v of ["2025-06-18", "2025-03-26", "2024-11-05"]) {
    const r: any = await handleMcp(rpc("initialize", { protocolVersion: v, capabilities: {}, clientInfo: { name: "t", version: "1" } }), ctx(["read"]));
    assert.equal(r.result.protocolVersion, v);
    assert.equal(r.id, 1);
    assert.equal(r.result.serverInfo.name, "the-mailroom");
    assert.deepEqual(r.result.capabilities, { tools: { listChanged: false } });
    assert.ok(r.result.instructions.length > 20);
  }
});

test("initialize with an unknown or missing version falls back to 2025-06-18", async () => {
  assert.equal(((await handleMcp(rpc("initialize", { protocolVersion: "1999-01-01" }), ctx(["read"])))!.result as any).protocolVersion, "2025-06-18");
  assert.equal(((await handleMcp(rpc("initialize"), ctx(["read"])))!.result as any).protocolVersion, "2025-06-18");
});

test("ping returns {} and keeps the id", async () => {
  assert.deepEqual(await handleMcp(rpc("ping", undefined, "abc"), ctx(["read"])), { jsonrpc: "2.0", id: "abc", result: {} });
});

test("notifications get no response, even unknown ones", async () => {
  assert.equal(await handleMcp({ jsonrpc: "2.0", method: "notifications/initialized" }, ctx(["read"])), null);
  assert.equal(await handleMcp({ jsonrpc: "2.0", method: "whatever/else" }, ctx(["read"])), null);
});

test("tools/list shows only what the scopes allow", async () => {
  const read = await names(["read"]);
  const write = await names(["read", "write"]);
  const approve = await names(["read", "approve"]);
  const all = await names(["read", "write", "approve", "propose"]);
  assert.equal(read.length, TOOLS.filter((t) => t.scope === "read").length);
  assert.ok(read.every((n: string) => n.startsWith("mailroom_")));
  assert.ok(!read.includes("mailroom_create_key") && !read.includes("mailroom_approve_parcel"));
  assert.ok(write.includes("mailroom_create_key") && write.includes("mailroom_revoke_key") && !write.includes("mailroom_approve_parcel"));
  assert.ok(approve.includes("mailroom_approve_parcel") && approve.includes("mailroom_decline_parcel") && !approve.includes("mailroom_create_key"));
  assert.equal(all.length, TOOLS.length);
  assert.ok((await names(["read", "propose"])).includes("mailroom_propose_contract") && !write.includes("mailroom_propose_contract"));
  // write alone still implies read
  assert.ok((await names(["write"])).includes("mailroom_status"));
});

test("every listed tool has a model-facing description and an object inputSchema", async () => {
  const tools = ((await handleMcp(rpc("tools/list"), ctx(["read", "write", "approve"])))!.result as any).tools;
  for (const t of tools) {
    assert.equal(t.inputSchema.type, "object");
    assert.ok(t.description.length > 40, t.name);
  }
  const d = (n: string) => tools.find((t: any) => t.name === n).description;
  assert.match(d("mailroom_create_key"), /only once/);
  assert.match(d("mailroom_create_key"), /never store/i);
  assert.match(d("mailroom_approve_parcel"), /show the owner/i);
  assert.match(d("mailroom_decline_parcel"), /show the owner/i);
});

test("unknown method is -32601", async () => {
  const r: any = await handleMcp(rpc("resources/list"), ctx(["read"]));
  assert.equal(r.error.code, -32601);
  assert.equal(r.id, 1);
});

test("unknown tool and bad params shape are -32602", async () => {
  assert.equal(((await handleMcp(rpc("tools/call", { name: "nope", arguments: {} }), ctx(["read"]))) as any).error.code, -32602);
  assert.equal(((await handleMcp(rpc("tools/call", {}), ctx(["read"]))) as any).error.code, -32602);
  assert.equal(((await handleMcp(rpc("tools/call", { name: "mailroom_status", arguments: [] }), ctx(["read"]))) as any).error.code, -32602);
});

test("bad JSON is -32700 with a null id", async () => {
  const r: any = await handleMcpText("{nope", ctx(["read"]));
  assert.equal(r.error.code, -32700);
  assert.equal(r.id, null);
});

test("a batch is rejected with -32600", async () => {
  const r: any = await handleMcp([rpc("ping")], ctx(["read"]));
  assert.equal(r.error.code, -32600);
  assert.equal(((await handleMcpText("[]", ctx(["read"]))) as any).error.code, -32600);
});

test("not a valid request is -32600", async () => {
  for (const m of [null, 5, "x", {}, { jsonrpc: "1.0", id: 1, method: "ping" }, { jsonrpc: "2.0", id: 1 }, { jsonrpc: "2.0", id: {}, method: "ping" }, { jsonrpc: "2.0", method: 5 }]) {
    assert.equal(((await handleMcp(m, ctx(["read"]))) as any).error.code, -32600, JSON.stringify(m));
  }
});

test("an unexpected failure inside a tool is -32603 and leaks nothing", async () => {
  const boom = new Proxy({}, { get: () => async () => { throw new Error("secret db path /x/y"); } }) as McpApi;
  const r: any = await handleMcp(rpc("tools/call", { name: "mailroom_status" }), { scopes: ["read"], api: boom });
  assert.equal(r.error.code, -32603);
  assert.ok(!JSON.stringify(r).includes("secret"));
});
