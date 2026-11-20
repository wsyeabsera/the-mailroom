import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
// @ts-ignore plain browser module
import { formatLocalMcp, parseLocalMcp, localMcpNeeded } from "../ui/js/local-mcp-form.js";
import { validateLocalMcp, LOCAL_MCP_MAX_SERVERS, LOCAL_MCP_MAX_TOOLS } from "../shared/local-mcp.ts";
import { validateContract, TASKS } from "../shared/contract.ts";

const ui = (t: string) => parseLocalMcp(t, validateLocalMcp);

test("text -> contract field: names, :auto and :ask", () => {
  const r: any = ui("files: read_file, list_dir:auto, write_file:ask\n\nnotes: search");
  assert.equal(r.ok, true);
  assert.deepEqual(r.localMcp, [
    { server: "files", tools: [{ name: "read_file" }, { name: "list_dir", approval: false }, { name: "write_file", approval: true }] },
    { server: "notes", tools: [{ name: "search" }] },
  ]);
  assert.deepEqual((ui("") as any).localMcp, []);
  assert.deepEqual((ui("  \n \n") as any).localMcp, []);
});

test("format and parse round-trip (including string-shorthand tools from the API)", () => {
  const text = "files: read_file, list_dir:auto, write_file:ask\nnotes: search";
  assert.equal(formatLocalMcp((ui(text) as any).localMcp), text);
  assert.equal(formatLocalMcp([{ server: "a", tools: ["x", { name: "y", approval: false }] }]), "a: x, y:auto");
  assert.equal(formatLocalMcp(undefined), "");
  assert.equal(formatLocalMcp("junk"), "");
});

test("bad input is refused with a sentence, never thrown", () => {
  for (const [text, re] of [
    ["no colon here", /Line 1/],
    [": tool", /Line 1/],
    ["files: a:maybe", /:auto or :ask/],
    ["files: a:b:c", /:auto or :ask/],
    ["bad name: a", /not a server name/],
    ["files: bad tool", /not a tool name/],
    ["files:", /needs 1 to/],
    ["files: a\nfiles: b", /listed twice/],
    ["files: a, a", /listed twice/],
    ["files: ../etc", /not a tool name/],
    ["Fíles: a", /not a server name/],
    ["files: *", /not a tool name/],
  ] as [string, RegExp][]) {
    const r: any = ui(text);
    assert.equal(r.ok, false, text);
    assert.match(r.error, re, text);
  }
  assert.equal((ui(Array.from({ length: LOCAL_MCP_MAX_SERVERS + 1 }, (_, i) => `s${i}: t`).join("\n")) as any).ok, false);
  assert.equal((ui("s: " + Array.from({ length: LOCAL_MCP_MAX_TOOLS + 1 }, (_, i) => `t${i}`).join(",")) as any).ok, false);
  assert.doesNotThrow(() => parseLocalMcp(undefined as any, validateLocalMcp));
  assert.doesNotThrow(() => parseLocalMcp("\0\n:::\n,,,", validateLocalMcp));
});

test("a command, args or env can never be typed in: the field only has names", () => {
  assert.equal((ui("files: node server.js") as any).ok, false);
  assert.equal((ui("files: cmd=node") as any).ok, false);
});

test("without a validator the editor still structures the text and the Hub's verdict stays the authority", () => {
  const r: any = parseLocalMcp("bad name: x");
  assert.equal(r.ok, true); // the Hub answers 422 errors.localMcp
  const hub = validateContract({ name: "n", folders: ["~/a"], tasks: ["mcp_list"], dailyLimit: 5, expires: null, approval: [], localMcp: r.localMcp }) as any;
  assert.equal(hub.ok, false);
  assert.match(hub.errors.localMcp, /not a server name/);
});

test("what the editor sends is accepted by validateContract, and mcp_* without servers is caught early and by the Hub", () => {
  const lm = (ui("files: read_file, list_dir:auto") as any).localMcp;
  const base = { name: "laptop tools", folders: ["~/a"], tasks: ["mcp_list", "mcp_call"], dailyLimit: 5, expires: null, approval: [] };
  const ok = validateContract({ ...base, localMcp: lm }) as any;
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.contract.localMcp, lm);
  assert.match(localMcpNeeded(["mcp_call"], [])!, /at least one local MCP server/);
  assert.equal(localMcpNeeded(["echo"], []), null);
  assert.equal(localMcpNeeded(["mcp_list"], lm), null);
  const none = validateContract({ ...base, localMcp: [] }) as any;
  assert.equal(none.ok, false);
  assert.equal(none.errors.localMcp, localMcpNeeded(["mcp_call"], []));
});

test("the contract editor page offers every task the editor can fill in, wires the field into the payload and the 422 error box", () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, "../ui/js/pages/contracts.js"), "utf8");
  const tasks = JSON.parse(/const ALL_TASKS = (\[.*?\]);/.exec(src)![1]);
  assert.ok(tasks.includes("mcp_list") && tasks.includes("mcp_call"));
  for (const t of tasks) assert.ok((TASKS as readonly string[]).includes(t), t);
  assert.match(src, /payload\.localMcp = lm\.localMcp/);
  assert.match(src, /id: "f-localMcp"/);
  assert.match(src, /field\("localMcp", localMcp\)/);
  assert.match(src, /localMcp: formatLocalMcp\(c\.localMcp\)/);
});
