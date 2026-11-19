// A tiny stdio MCP server for tests (newline-delimited JSON-RPC 2.0). argv[2]: a file that gets one line appended per process start.
// Tools: echo (readOnly), peek_env (readOnly), pid (readOnly), write_thing (no annotations), slow (readOnly, never answers),
//        crash (readOnly, exits), big (readOnly, 1 MB of text), hidden (readOnly, not in any contract), fail (reports isError).
import fs from "node:fs";
import readline from "node:readline";

if (process.argv[2]) fs.appendFileSync(process.argv[2], `${process.pid}\n`);
const RO = { readOnlyHint: true };
const T = (name, extra = {}) => ({ name, description: `the ${name} tool`, inputSchema: { type: "object", properties: {} }, ...extra });
const PAGE1 = [T("echo", { annotations: RO }), T("write_thing"), T("slow", { annotations: RO }), T("crash", { annotations: RO })];
const PAGE2 = [T("big", { annotations: RO }), T("peek_env", { annotations: RO }), T("pid", { annotations: RO }), T("hidden", { annotations: RO }), T("fail", { annotations: RO })];
const text = t => ({ content: [{ type: "text", text: t }] });

readline.createInterface({ input: process.stdin }).on("line", l => {
  const m = JSON.parse(l);
  const send = result => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\n");
  if (m.method === "initialize") send({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } });
  else if (m.method === "tools/list") m.params?.cursor === "p2" ? send({ tools: PAGE2 }) : send({ tools: PAGE1, nextCursor: "p2" });
  else if (m.method === "tools/call") {
    const { name, arguments: a } = m.params;
    if (name === "echo") send(text(JSON.stringify(a)));
    else if (name === "write_thing") send(text("wrote"));
    else if (name === "slow") { /* never answers */ }
    else if (name === "crash") process.exit(3);
    else if (name === "big") send(text("x".repeat(1024 * 1024)));
    else if (name === "peek_env") send(text(JSON.stringify(process.env)));
    else if (name === "pid") send(text(String(process.pid)));
    else if (name === "fail") send({ isError: true, content: [{ type: "text", text: "nope" }] });
    else send(text(`ran ${name}`));
  } else if (m.id !== undefined) send({});
});
