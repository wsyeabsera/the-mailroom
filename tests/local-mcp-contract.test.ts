import test from "node:test";
import assert from "node:assert/strict";
import { check, validateContract, jobPaths, type Contract } from "../shared/contract.ts";
import { checkLocalMcp, validateLocalMcp, findLocalMcpTool } from "../shared/local-mcp.ts";
import { laneOf } from "../shared/lanes.ts";

const ctx = { now: Date.parse("2026-11-15T12:00:00Z"), usedToday: 0 };
const base: Contract = {
  name: "Chat", folders: ["~/x"], tasks: ["echo", "mcp_list", "mcp_call"], dailyLimit: 50, expires: null, approval: [],
  localMcp: [
    { server: "notes", tools: [{ name: "search", approval: false }, { name: "append" }, { name: "wipe", approval: true }, { name: "list.items" }] },
    { server: "git-ro", tools: [{ name: "log", approval: false }] },
  ],
};
const call = (c: Contract, args: Record<string, unknown>) => check(c, { task: "mcp_call", args }, ctx);
const form = { name: "Chat", folders: ["~/x"], tasks: ["mcp_call"], dailyLimit: 5 };

test("mcp_call table: allowed, approval and refusals", () => {
  const rows: [string, Record<string, unknown>, string][] = [
    ["approval:false tool runs without waiting", { server: "notes", tool: "search", args: { q: "a" } }, "allow"],
    ["a tool with no flag waits", { server: "notes", tool: "append" }, "approve"],
    ["approval:true waits", { server: "notes", tool: "wipe" }, "approve"],
    ["dots in a tool name", { server: "notes", tool: "list.items" }, "approve"],
    ["second server", { server: "git-ro", tool: "log" }, "allow"],
    ["unknown server", { server: "mail", tool: "search" }, "refuse"],
    ["a tool of the other server", { server: "git-ro", tool: "search" }, "refuse"],
    ["unknown tool", { server: "notes", tool: "delete" }, "refuse"],
    ["missing server", { tool: "search" }, "refuse"],
    ["missing tool", { server: "notes" }, "refuse"],
    ["server is not a string", { server: ["notes"], tool: "search" }, "refuse"],
    ["tool is not a string", { server: "notes", tool: { toString: "search" } }, "refuse"],
    ["args must be an object", { server: "notes", tool: "search", args: "x" }, "refuse"],
    ["args array", { server: "notes", tool: "search", args: [] }, "refuse"],
    ["args null", { server: "notes", tool: "search", args: null }, "refuse"],
    ["args too big", { server: "notes", tool: "search", args: { q: "x".repeat(70_000) } }, "refuse"],
    ["a command in the job", { server: "notes", tool: "search", command: "sh" }, "refuse"],
    ["argv in the job", { server: "notes", tool: "search", argv: ["sh"] }, "refuse"],
    ["env in the job", { server: "notes", tool: "search", env: { A: "1" } }, "refuse"],
    ["cwd in the job", { server: "notes", tool: "search", cwd: "/" }, "refuse"],
    ["timeout in the job", { server: "notes", tool: "search", timeoutMs: 1 }, "refuse"],
  ];
  for (const [why, args, verdict] of rows) assert.equal(call(base, args).verdict, verdict, why);
});

test("mcp_list table", () => {
  const list = (args: Record<string, unknown>) => check(base, { task: "mcp_list", args }, ctx).verdict;
  assert.equal(list({}), "allow");
  assert.equal(list({ server: "notes" }), "allow");
  assert.equal(list({ server: "mail" }), "refuse");
  assert.equal(list({ server: "notes", command: "sh" }), "refuse");
  assert.equal(list({ server: "notes", tool: "search" }), "refuse");
  assert.equal(check({ ...base, localMcp: [] }, { task: "mcp_list", args: {} }, ctx).verdict, "refuse");
  assert.equal(check({ ...base, tasks: ["echo"] }, { task: "mcp_list", args: {} }, ctx).verdict, "refuse");
  assert.equal(check({ ...base, tasks: ["mcp_list"], approval: ["mcp_list"] }, { task: "mcp_list", args: {} }, ctx).verdict, "approve");
});

test("the task-level approval list still applies to mcp_call, even for an approval:false tool", () => {
  assert.equal(call({ ...base, approval: ["mcp_call"] }, { server: "notes", tool: "search" }).verdict, "approve");
});

test("a contract that lacks localMcp, or the task, refuses mcp_call", () => {
  const { localMcp, ...none } = base;
  assert.equal(call(none, { server: "notes", tool: "search" }).verdict, "refuse");
  assert.equal(check({ ...base, tasks: ["echo"] }, { task: "mcp_call", args: { server: "notes", tool: "search" } }, ctx).verdict, "refuse");
  assert.deepEqual(jobPaths({ task: "mcp_call", args: {} }), []);
  assert.equal(laneOf("mcp_call", {}), "long");
});

test("a malformed stored contract never throws", () => {
  for (const localMcp of [null, "x", 5, [null], [{ server: "notes" }], [{ server: "notes", tools: "search" }], { notes: {} }] as unknown[]) {
    const v = check({ ...base, localMcp: localMcp as never }, { task: "mcp_call", args: { server: "notes", tool: "search" } }, ctx);
    assert.equal(v.verdict, "refuse");
  }
});

test("validateContract: accepts the field, normalises, and rejects anything that could name a command", () => {
  const ok = validateContract({ ...form, localMcp: [{ server: "notes", tools: ["search", { name: "append", approval: true }] }] });
  assert.equal(ok.ok, true);
  assert.deepEqual((ok as any).contract.localMcp, [{ server: "notes", tools: [{ name: "search" }, { name: "append", approval: true }] }]);
  assert.equal("localMcp" in (validateContract({ name: "x", folders: ["~/x"], tasks: ["echo"], dailyLimit: 1 }) as any).contract, false);
  const bad: [string, unknown][] = [
    ["tasks need servers", undefined],
    ["empty list", []],
    ["not a list", { server: "notes" }],
    ["a command on the server", [{ server: "notes", tools: ["a"], command: "sh" }]],
    ["args on the server", [{ server: "notes", tools: ["a"], args: ["-c"] }]],
    ["env on the server", [{ server: "notes", tools: ["a"], env: {} }]],
    ["a command on a tool", [{ server: "notes", tools: [{ name: "a", command: "sh" }] }]],
    ["no tools", [{ server: "notes", tools: [] }]],
    ["wildcard tool", [{ server: "notes", tools: ["*"] }]],
    ["bad server name", [{ server: "no tes", tools: ["a"] }]],
    ["path-like server", [{ server: "../x", tools: ["a"] }]],
    ["approval not boolean", [{ server: "notes", tools: [{ name: "a", approval: "no" }] }]],
    ["duplicate server", [{ server: "notes", tools: ["a"] }, { server: "notes", tools: ["b"] }]],
    ["duplicate tool", [{ server: "notes", tools: ["a", "a"] }]],
    ["too many tools", [{ server: "notes", tools: Array.from({ length: 51 }, (_, i) => `t${i}`) }]],
    ["too many servers", Array.from({ length: 11 }, (_, i) => ({ server: `s${i}`, tools: ["a"] }))],
  ];
  for (const [why, localMcp] of bad) {
    const v = validateContract({ ...form, localMcp });
    assert.equal(v.ok, false, why);
    assert.ok((v as any).errors.localMcp, why);
  }
});

// ---- properties (seeded, so a failure is reproducible) ----
function rng(seed: number) {
  return () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const TRICKS = ["", " ", "\0", "​", " ", "﻿", "‮", "ｓ", "ｅarch", "ѕearch", "ѕеarch", "ＳＥＡＲＣＨ", "SEARCH", "Search", "search ", " search", "search\n", "search\0", "sea​rch", "sеarch", "ſearch", "ǅ", "K", "K", "İ", "ı", "__proto__", "constructor", "toString", "hasOwnProperty", "notes\0", "NOTES", "Notes", "ｎotes", "notes/../notes", "notes ", "noteś", "append́", "wipe", "a".repeat(65), "\u{1d5a0}"];
const WORDS = ["notes", "git-ro", "search", "append", "wipe", "list.items", "log", "mail", "x", "delete"];
const pieces = [...TRICKS, ...WORDS];
const gen = (r: () => number) => {
  const n = Math.floor(r() * 3) + 1;
  let s = "";
  for (let i = 0; i < n; i++) s += pieces[Math.floor(r() * pieces.length)];
  if (r() < 0.2) s = s.toUpperCase();
  if (r() < 0.2) s = s.normalize(r() < 0.5 ? "NFKC" : "NFD");
  return s;
};

test("property: a job reaches a server and tool only if the contract lists that exact name", () => {
  const r = rng(2910);
  const servers = new Set(base.localMcp!.map(s => s.server));
  const tools = new Map(base.localMcp!.map(s => [s.server, new Set(s.tools.map(t => t.name))]));
  let allowed = 0;
  for (let i = 0; i < 20_000; i++) {
    const server = r() < 0.4 ? pieces[Math.floor(r() * 2) + 40] : gen(r);
    const tool = gen(r);
    const v = call(base, { server, tool });
    const exact = servers.has(server) && tools.get(server)!.has(tool);
    assert.equal(v.verdict !== "refuse", exact, `${JSON.stringify(server)} ${JSON.stringify(tool)}`);
    assert.equal(findLocalMcpTool(base, server, tool) !== null, exact);
    if (exact) allowed++;
  }
  assert.ok(allowed > 50, "the generator must hit allowed names too"); // otherwise the property proves nothing
});

test("property: no extra key in a job can pass, whatever its name or value", () => {
  const r = rng(2911);
  const allowedKeys = ["server", "tool", "args"];
  for (let i = 0; i < 5000; i++) {
    const key = r() < 0.5 ? gen(r) : ["command", "argv", "env", "cwd", "cmd", "shell", "path", "timeoutMs", "Server", "SERVER", "tool "][Math.floor(r() * 11)];
    if (allowedKeys.includes(key)) continue;
    const v = call(base, { server: "notes", tool: "search", [key]: gen(r) });
    assert.equal(v.verdict, "refuse", JSON.stringify(key));
    assert.equal(checkLocalMcp(base, "mcp_list", { server: "notes", [key]: 1 }).hasOwnProperty("refuse"), key !== "server");
  }
});

test("property: validateLocalMcp accepts a name only if it is strict ASCII, and what it accepts round-trips exactly", () => {
  const r = rng(77);
  for (let i = 0; i < 5000; i++) {
    const name = gen(r);
    const v = validateLocalMcp([{ server: "s", tools: [name] }]);
    const strict = /^[A-Za-z0-9_.-]{1,64}$/.test(name);
    assert.equal(v.ok, strict, JSON.stringify(name));
    if (v.ok) assert.equal(v.servers[0].tools[0].name, name); // never trimmed, folded or normalised
  }
});

test("property: approval is required unless the tool says approval:false (and the task list does not require it)", () => {
  const r = rng(5);
  for (let i = 0; i < 300; i++) {
    const approval = [undefined, true, false][Math.floor(r() * 3)];
    const c: Contract = { ...base, localMcp: [{ server: "s", tools: [{ name: "t", ...(approval !== undefined ? { approval } : {}) }] }] };
    assert.equal(call(c, { server: "s", tool: "t" }).verdict, approval === false ? "allow" : "approve");
  }
});
