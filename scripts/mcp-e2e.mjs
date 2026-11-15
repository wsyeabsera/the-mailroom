// End to end for the MCP channel with a REAL MCP client: Claude Code loading ./plugin against a local Worker.
// Needs the `claude` CLI signed in (it makes a few tiny requests). Run: node scripts/mcp-e2e.mjs
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 8804;
const BASE = `http://localhost:${PORT}`;
const root = new URL("..", import.meta.url).pathname;
const pass = readFileSync(join(root, ".dev.vars"), "utf8").match(/^OWNER_PASSWORD=(.*)$/m)[1];
const tmp = mkdtempSync(join(tmpdir(), "mr-mcp-"));
const procs = [];
let failed = 0;
const ok = (c, m) => { if (c) console.log(`  ok   ${m}`); else { failed++; console.log(`  FAIL ${m}`); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const killGroup = p => { try { process.kill(-p.pid, "SIGKILL"); } catch { try { p.kill("SIGKILL"); } catch {} } };
process.on("exit", () => { for (const p of procs) killGroup(p); try { rmSync(tmp, { recursive: true, force: true }); } catch {} });
async function until(fn, ms = 20000) { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(250); } return null; }

console.log("starting the Worker ...");
const w = spawn("npx", ["wrangler", "dev", "--port", String(PORT), "--inspector-port", "9355", "--persist-to", join(tmp, "state")], { cwd: root, stdio: "ignore", detached: true });
procs.push(w);
if (!(await until(async () => { try { return (await fetch(BASE + "/admin/state")).status === 401; } catch { return false; } }, 60000))) { console.log("FAIL the Worker did not start"); process.exit(1); }

let cookie = "";
const owner = async (m, p, b) => { const r = await fetch(BASE + p, { method: m, headers: { cookie, "content-type": "application/json", origin: BASE }, body: b === undefined ? undefined : JSON.stringify(b) }); const t = await r.text(); return { s: r.status, j: t ? JSON.parse(t) : null, h: r.headers }; };
cookie = (await owner("POST", "/admin/login", { password: pass })).h.get("set-cookie").split(";")[0];
const contract = (await owner("POST", "/admin/contracts", { name: "Notes writer", folders: ["~/Hobby/dunder/notes"], tasks: ["echo", "write_file"], dailyLimit: 50, expires: null, approval: ["write_file"] })).j;
const key = (await owner("POST", "/admin/keys", { label: "Dunder Miffbot (prod)", contract_id: contract.id })).j.key;
const job = async name => (await (await fetch(BASE + "/api/jobs", { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ task: "write_file", args: { path: `~/Hobby/dunder/notes/${name}`, content: "x" } }) })).json()).id;
const p1 = await job("standup.md");
await job("ideas.md");
const readTok = (await owner("POST", "/admin/tokens", { label: "e2e read", scopes: ["read"] })).j.token;
const writeTok = (await owner("POST", "/admin/tokens", { label: "e2e write", scopes: ["write"] })).j.token;
ok(readTok?.startsWith("mra_") && writeTok?.startsWith("mra_"), "two admin tokens created (read, write)");

const SERVER = "mcp__plugin_the-mailroom_mailroom";
function ask(token, prompt) {
  const r = spawnSync("claude", ["--plugin-dir", join(root, "plugin"), "-p", prompt, "--output-format", "json", "--max-turns", "6", "--allowedTools", SERVER], {
    env: { ...process.env, MAILROOM_URL: BASE, MAILROOM_TOKEN: token }, encoding: "utf8", timeout: 240000, cwd: tmp,
  });
  try { const j = JSON.parse(r.stdout); return { text: String(j.result ?? ""), raw: j, status: r.status }; } catch { return { text: r.stdout + r.stderr, status: r.status }; }
}

console.log("a read token, through a real MCP client");
let a = ask(readTok, "Use the mailroom MCP tools. Call the status tool, then answer in one short sentence: how many parcels are waiting for approval, and which key label asked for them? Do not guess; use the tool.");
console.log(`    claude said: ${a.text.replace(/\s+/g, " ").slice(0, 200)}`);
ok(/\b2\b|two/i.test(a.text) && /Dunder Miffbot/.test(a.text), "Claude read the live status through /mcp (2 waiting, key label)");

a = ask(readTok, `Use the mailroom MCP tools only. Approve parcel ${p1} if you can. If the tools do not let you, say plainly what is missing. Never try any other way.`);
console.log(`    claude said: ${a.text.replace(/\s+/g, " ").slice(0, 220)}`);
let st = (await owner("GET", `/admin/jobs/${p1}`)).j;
ok(st.state === "waiting_approval", `a read-only token could not approve it: ${p1} is still ${st.state}`);

console.log("a write token creates a key");
a = ask(writeTok, `Use the mailroom MCP tools. Create a key with the label "from claude" on the contract named "Notes writer" (find its id with the tools first). Reply with only the key's id and label.`);
console.log(`    claude said: ${a.text.replace(/\s+/g, " ").slice(0, 200)}`);
const keys = (await owner("GET", "/admin/keys")).j;
ok(keys.some(k => k.label === "from claude"), "the key exists on the server");
const ev = (await owner("GET", "/admin/events?after=0&limit=500")).j.events;
const calls = ev.filter(e => e.kind === "mcp.call");
ok(calls.some(e => e.payload.tool === "mailroom_create_key" && e.payload.ok === true && e.payload.label === "e2e write"), "the write was audited as an mcp.call event");
ok(!JSON.stringify(ev).includes("mr_live_") && !JSON.stringify(ev).includes(writeTok) && !JSON.stringify(ev).includes(readTok), "no key or token appears in the event log");
ok(!a.text.includes("mr_live_"), "Claude did not repeat the new key in its reply (it was told to give only id and label)");

console.log("a revoked token");
const toks = (await owner("GET", "/admin/tokens")).j;
await owner("POST", `/admin/tokens/${toks.find(t => t.label === "e2e write").id}/revoke`);
const dead = await fetch(BASE + "/mcp", { method: "POST", headers: { authorization: `Bearer ${writeTok}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
ok(dead.status === 401, "a revoked token is refused on its next request (401)");

console.log(failed ? `\nMCP E2E FAILED (${failed})` : "\nMCP E2E PASSED");
for (const p of procs) killGroup(p);
process.exit(failed ? 1 : 0);
