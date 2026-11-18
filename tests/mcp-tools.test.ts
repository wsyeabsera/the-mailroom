import test from "node:test";
import assert from "node:assert/strict";
import { handleMcp, TOOLS, ToolError, type AuditEntry, type McpApi } from "../src/mcp.ts";

type Call = [string, ...unknown[]];
function fake() {
  const calls: Call[] = [];
  const audits: AuditEntry[] = [];
  const rec = (name: string, ret: unknown = { ok: true }) => async (...a: unknown[]) => { calls.push([name, ...a]); return ret; };
  const api: McpApi = {
    status: rec("status", { approvals: 0 }),
    listParcels: rec("listParcels", [{ id: "p_1001" }]),
    getParcel: rec("getParcel"),
    listKeys: rec("listKeys", []),
    getKey: rec("getKey"),
    listContracts: rec("listContracts", []),
    getContract: rec("getContract"),
    events: rec("events", { events: [], last_seq: 0 }),
    laptop: rec("laptop"),
    createContract: rec("createContract", { id: "c_1000" }),
    updateContract: rec("updateContract", { id: "c_1000" }),
    listProjects: rec("listProjects", []),
    getProject: rec("getProject"),
    createProject: rec("createProject", { id: "pr_1000" }),
    updateProject: rec("updateProject", { id: "pr_1000" }),
    listProposals: rec("listProposals", []),
    proposeContract: rec("proposeContract", { id: "pp_1000", state: "pending" }),
    createKey: rec("createKey", { id: "k_1000", label: "x", key: "mr_live_TESTSECRET" }),
    revokeKey: rec("revokeKey", { id: "k_1000", revoked_at: 1, cancelled: 0 }),
    approveParcel: rec("approveParcel", { id: "p_1001", state: "queued" }),
    declineParcel: rec("declineParcel", { id: "p_1001", state: "refused" }),
  };
  return { api, calls, audits, audit: (e: AuditEntry) => void audits.push(e) };
}
const call = (f: ReturnType<typeof fake>, scopes: string[], name: string, args?: unknown) =>
  handleMcp({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name, arguments: args } }, { scopes, api: f.api, audit: f.audit }) as Promise<any>;

const GOOD: Record<string, Record<string, unknown>> = {
  mailroom_status: {}, mailroom_list_parcels: {}, mailroom_get_parcel: { id: "p_1001" }, mailroom_list_keys: {}, mailroom_get_key: { id: "k_1000" },
  mailroom_list_contracts: {}, mailroom_get_contract: { id: "c_1000" }, mailroom_events: {}, mailroom_laptop: {},
  mailroom_create_contract: { name: "N", folders: ["~/a"], tasks: ["echo"], dailyLimit: 5, approval: [] },
  mailroom_update_contract: { id: "c_1000", name: "N", folders: ["~/a"], tasks: ["echo"], dailyLimit: 5, approval: [] },
  mailroom_list_projects: {}, mailroom_get_project: { project: "pr_1000" }, mailroom_create_project: { name: "P" }, mailroom_update_project: { project: "pr_1000", notes: "n" },
  mailroom_list_proposals: {}, mailroom_propose_contract: { contract_id: "c_1000", changes: { dailyLimit: 9 } },
  mailroom_create_key: { label: "L", contract_id: "c_1000" }, mailroom_revoke_key: { id: "k_1000" },
  mailroom_approve_parcel: { id: "p_1001" }, mailroom_decline_parcel: { id: "p_1001" },
};

test("every tool has sample arguments and a scope", () => {
  assert.deepEqual(Object.keys(GOOD).sort(), TOOLS.map((t) => t.name).sort());
});

test("scope enforcement: every tool, every scope set", async () => {
  const sets: [string[], string[]][] = [[["read"], ["read"]], [["read", "write"], ["read", "write"]], [["read", "approve"], ["read", "approve"]], [["write"], ["read", "write"]], [["read", "propose"], ["read", "propose"]]];
  for (const [scopes, allowed] of sets) {
    for (const t of TOOLS) {
      const f = fake();
      const r = await call(f, scopes, t.name, GOOD[t.name]);
      if (allowed.includes(t.scope)) {
        assert.equal(r.result.isError, false, `${scopes} ${t.name}`);
        assert.equal(f.calls.length, 1);
      } else {
        assert.equal(r.result.isError, true, `${scopes} ${t.name}`);
        assert.match(r.result.content[0].text, new RegExp(`This token cannot do that \\(needs the ${t.scope} scope\\)`));
        assert.equal(f.calls.length, 0, "the api is never touched");
      }
    }
  }
});

test("write does not give approve and approve does not give write", async () => {
  const f = fake();
  assert.equal((await call(f, ["read", "write"], "mailroom_approve_parcel", { id: "p_1001" })).result.isError, true);
  assert.equal((await call(f, ["read", "approve"], "mailroom_revoke_key", { id: "k_1000" })).result.isError, true);
  assert.equal(f.calls.length, 0);
});

test("results are content text plus structuredContent", async () => {
  const f = fake();
  const r = await call(f, ["read"], "mailroom_status");
  assert.equal(r.result.content[0].type, "text");
  assert.deepEqual(JSON.parse(r.result.content[0].text), { approvals: 0 });
  assert.deepEqual(r.result.structuredContent, { approvals: 0 });
  assert.equal(r.result.isError, false);
  const l = await call(f, ["read"], "mailroom_list_parcels");
  assert.deepEqual(JSON.parse(l.result.content[0].text), [{ id: "p_1001" }]);
  assert.deepEqual(l.result.structuredContent, { items: [{ id: "p_1001" }] });
});

test("defaults and arguments reach the api", async () => {
  const f = fake();
  await call(f, ["read"], "mailroom_list_parcels", { state: "queued" });
  await call(f, ["read"], "mailroom_events");
  await call(f, ["read"], "mailroom_events", { after: 4, limit: 9 });
  await call(f, ["read", "write"], "mailroom_update_contract", GOOD.mailroom_update_contract);
  await call(f, ["read", "approve"], "mailroom_decline_parcel", { id: "p_1", reason: "nope" });
  assert.deepEqual(f.calls[0], ["listParcels", { state: "queued", limit: 50 }]);
  assert.deepEqual(f.calls[1], ["events", { after: 0, limit: 200 }]);
  assert.deepEqual(f.calls[2], ["events", { after: 4, limit: 9 }]);
  assert.equal(f.calls[3][1], "c_1000");
  assert.equal((f.calls[3][2] as any).id, undefined, "the id is not part of the contract body");
  assert.deepEqual(f.calls[4], ["declineParcel", "p_1", "nope"]);
});

test("argument validation gives plain isError results and never calls the api", async () => {
  const f = fake();
  const bad: [string, string[], unknown, RegExp][] = [
    ["mailroom_get_parcel", ["read"], {}, /"id" is required/],
    ["mailroom_get_parcel", ["read"], { id: 5 }, /"id" must be a string/],
    ["mailroom_list_parcels", ["read"], { limit: 0 }, /"limit" must be at least 1/],
    ["mailroom_list_parcels", ["read"], { limit: 201 }, /"limit" must be at most 200/],
    ["mailroom_list_parcels", ["read"], { limit: 1.5 }, /whole number/],
    ["mailroom_list_parcels", ["read"], { state: "bogus" }, /one of/],
    ["mailroom_events", ["read"], { limit: 501 }, /at most 500/],
    ["mailroom_events", ["read"], { after: -1 }, /at least 0/],
    ["mailroom_status", ["read"], { extra: 1 }, /Unknown argument "extra"/],
    ["mailroom_create_key", ["read", "write"], { label: "", contract_id: "c_1" }, /at least 1/],
    ["mailroom_create_key", ["read", "write"], { label: "x".repeat(61), contract_id: "c_1" }, /at most 60/],
    ["mailroom_create_key", ["read", "write"], { label: "x" }, /"contract_id" is required/],
    ["mailroom_create_contract", ["read", "write"], { name: "N", extra: 1 }, /Unknown argument "extra"/],
    ["mailroom_update_contract", ["read", "write"], { name: "N" }, /"id" is required/],
  ];
  for (const [name, scopes, args, re] of bad) {
    const r = await call(f, scopes, name, args);
    assert.equal(r.result.isError, true, name + JSON.stringify(args));
    assert.match(r.result.content[0].text, re, name);
  }
  assert.equal(f.calls.length, 0);
});

test("a missing contract field is worded by validateContract's messages via the api", async () => {
  const f = fake();
  // Soft tools skip `required`, so an empty call reaches the api, where validateContract words it.
  for (const bad of [{}, { name: "N", folders: "~/a", tasks: ["rm"], dailyLimit: "5" }]) {
    const r = await call(f, ["read", "write"], "mailroom_create_contract", bad);
    assert.equal(r.result.isError, false);
  }
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls[1][1], { name: "N", folders: "~/a", tasks: ["rm"], dailyLimit: "5" });
});

test("a ToolError from the api is an isError result with its message and details", async () => {
  const f = fake();
  f.api.createContract = async () => { throw new ToolError("Nothing was saved. name: Give it a short name (letters, numbers, spaces).", { name: "Give it a short name (letters, numbers, spaces)." }); };
  const r = await call(f, ["read", "write"], "mailroom_create_contract", { name: "!", folders: ["~/a"], tasks: ["echo"], dailyLimit: 5, approval: [] });
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /Give it a short name/);
  assert.match(r.result.structuredContent.error, /Nothing was saved/);
  assert.equal(r.error, undefined);
});

test("audit: writes and approvals are reported (ok and failed), reads are not", async () => {
  const f = fake();
  await call(f, ["read"], "mailroom_status");
  await call(f, ["read"], "mailroom_get_key", { id: "k_1" });
  assert.equal(f.audits.length, 0);

  await call(f, ["read", "write"], "mailroom_create_key", GOOD.mailroom_create_key);
  await call(f, ["read", "write"], "mailroom_revoke_key", { id: "k_1000" });
  await call(f, ["read", "write"], "mailroom_create_contract", GOOD.mailroom_create_contract);
  await call(f, ["read", "approve"], "mailroom_approve_parcel", { id: "p_1001" });
  assert.deepEqual(f.audits, [
    { tool: "mailroom_create_key", ok: true, target: "k_1000" },
    { tool: "mailroom_revoke_key", ok: true, target: "k_1000" },
    { tool: "mailroom_create_contract", ok: true, target: "c_1000" },
    { tool: "mailroom_approve_parcel", ok: true, target: "p_1001" },
  ]);

  f.audits.length = 0;
  f.api.revokeKey = async () => { throw new ToolError("Key k_9 not found."); };
  await call(f, ["read", "write"], "mailroom_revoke_key", { id: "k_9" });
  await call(f, ["read"], "mailroom_approve_parcel", { id: "p_1" }); // refused for scope: still a failed write attempt
  await call(f, ["read", "write"], "mailroom_create_key", { label: "" }); // validation failure
  assert.deepEqual(f.audits, [
    { tool: "mailroom_revoke_key", ok: false, target: "k_9" },
    { tool: "mailroom_approve_parcel", ok: false, target: "p_1" },
    { tool: "mailroom_create_key", ok: false, target: undefined },
  ]);
});

test("the audit entry never contains the created key", async () => {
  const f = fake();
  await call(f, ["read", "write"], "mailroom_create_key", GOOD.mailroom_create_key);
  assert.ok(!JSON.stringify(f.audits).includes("TESTSECRET"));
});

test("an audit callback that throws does not change the result", async () => {
  const f = fake();
  const r: any = await handleMcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "mailroom_revoke_key", arguments: { id: "k_1000" } } }, { scopes: ["write"], api: f.api, audit: () => { throw new Error("x"); } });
  assert.equal(r.result.isError, false);
});

test("project tools: read scope lists and gets, only write creates and updates", async () => {
  const f = fake();
  assert.equal((await call(f, ["read"], "mailroom_list_projects")).result.isError, false);
  assert.equal((await call(f, ["read"], "mailroom_get_project", { project: "pr_1000" })).result.isError, false);
  for (const [n, a] of [["mailroom_create_project", { name: "P" }], ["mailroom_update_project", { project: "pr_1000", name: "Q" }]] as const) {
    const r = await call(f, ["read"], n, a);
    assert.equal(r.result.isError, true);
    assert.match(r.result.content[0].text, /needs the write scope/);
  }
  assert.deepEqual(f.calls.map((c) => c[0]), ["listProjects", "getProject"]);
  assert.equal((await call(f, ["read", "write"], "mailroom_create_project", { name: "P", folder: "~/x" })).result.isError, false);
  await call(f, ["read", "write"], "mailroom_update_project", { project: "pr_1000", color: "#aabbcc" });
  assert.deepEqual(f.calls[2], ["createProject", { name: "P", folder: "~/x" }]);
  assert.deepEqual(f.calls[3], ["updateProject", "pr_1000", { color: "#aabbcc" }]);
  assert.deepEqual(f.audits.slice(2), [{ tool: "mailroom_create_project", ok: true, target: "pr_1000" }, { tool: "mailroom_update_project", ok: true, target: "pr_1000" }]);
});

test("project tool arguments are validated; create_key passes project_id through", async () => {
  const f = fake();
  const w = ["read", "write"];
  assert.match((await call(f, w, "mailroom_create_project", {})).result.content[0].text, /"name" is required/);
  assert.match((await call(f, w, "mailroom_update_project", { name: "x" })).result.content[0].text, /"project" is required/);
  assert.match((await call(f, ["read"], "mailroom_get_project", {})).result.content[0].text, /"project" is required/);
  assert.equal(f.calls.length, 0);
  await call(f, w, "mailroom_create_key", { label: "L", contract_id: "c_1", project_id: "pr_1000" });
  await call(f, w, "mailroom_create_key", { label: "L", contract_id: "c_1" });
  assert.deepEqual(f.calls[0], ["createKey", { label: "L", contract_id: "c_1", project_id: "pr_1000" }]);
  assert.deepEqual(f.calls[1], ["createKey", { label: "L", contract_id: "c_1" }]);
});

test("propose is its own scope: it cannot update contracts, approve or create keys, and write cannot propose", async () => {
  const f = fake();
  for (const t of ["mailroom_update_contract", "mailroom_create_contract", "mailroom_create_key", "mailroom_approve_parcel"])
    assert.equal((await call(f, ["read", "propose"], t, GOOD[t])).result.isError, true, t);
  assert.equal((await call(f, ["read", "write"], "mailroom_propose_contract", GOOD.mailroom_propose_contract)).result.isError, true);
  assert.equal(f.calls.length, 0);
  const ok = await call(f, ["read", "propose"], "mailroom_propose_contract", { ...GOOD.mailroom_propose_contract, note: "why" });
  assert.equal(ok.result.isError, false);
  assert.deepEqual(f.calls[0], ["proposeContract", { contract_id: "c_1000", changes: { dailyLimit: 9 }, note: "why" }]);
  assert.deepEqual(f.audits.at(-1), { tool: "mailroom_propose_contract", ok: true, target: "pp_1000" });
});
