// The laptop-side confinement of claude jobs (daemon/claude.ts confineArgv, ruleDir). The pure tests pin exactly what claude is started with;
// the gated live test (MAILROOM_LIVE_CLAUDE=1) runs the real `claude -p` with that argv against decoy files, and also pins the stream-json shapes.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { confineArgv, ruleDir, RISKY_TOOLS, StreamReader } from "../daemon/claude.ts";

const DIR = "/Users/me/proj";
const RISKY = ["Bash", "Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch"];

test("ruleDir writes an absolute path as //abs/**, refuses anything a rule would read as syntax", () => {
  assert.equal(ruleDir("/Users/me/proj"), "//Users/me/proj/**");
  assert.equal(ruleDir("/Users/me/proj/"), "//Users/me/proj/**");
  assert.equal(ruleDir("/"), "//**");
  assert.equal(ruleDir("/Users/me/my proj-1_x.y"), "//Users/me/my proj-1_x.y/**");
  assert.throws(() => ruleDir("relative/dir"), /not absolute/);
  for (const bad of ["/a/*", "/a/b?c", "/a/[x]", "/a/{x,y}", "/a/(x)", "/a/!x", "/a/#x", "/a/b\\c", "/a/b\nc", "/a/b\0c", "/a/b,c"]) assert.throws(() => ruleDir(bad), /cannot be written in a permission rule/, JSON.stringify(bad));
});

test("default read-only job: Read/Glob/Grep scoped to the folder, every risky tool removed, dontAsk", () => {
  const out = confineArgv(["--allowedTools", "Read", "Glob", "Grep", "--max-turns", "5"], [DIR]);
  assert.deepEqual(out, [
    "--allowedTools", "Read(//Users/me/proj/**)", "Glob(//Users/me/proj/**)", "Grep(//Users/me/proj/**)",
    "--max-turns", "5",
    "--disallowedTools", ...RISKY, "--permission-mode", "dontAsk",
  ]);
  assert.deepEqual(RISKY_TOOLS, RISKY);
});

test("no bare Read, Glob or Grep ever reaches claude (a bare grant reads the whole disk: seen live)", () => {
  const out = confineArgv(["--allowedTools", "Read", "Grep", "Glob", "Edit", "Write", "NotebookEdit", "--max-turns", "3"], [DIR, "/Users/me/scratch/j1"]);
  const granted = out.slice(1, out.indexOf("--max-turns"));
  for (const g of granted) assert.match(g, /^(Read|Glob|Grep|Edit)\(\/\/.+\/\*\*\)$/, g);
  assert.ok(!granted.some(g => ["Read", "Glob", "Grep", "Edit", "Write", "NotebookEdit"].includes(g)));
  // Write and NotebookEdit are covered by Edit rules (verified live), deduplicated
  assert.equal(granted.filter(g => g.startsWith("Edit(")).length, 2);
});

test("scratch jobs: both the scratch dir and the contract folder are allowed, nothing else", () => {
  const out = confineArgv(["--allowedTools", "Read"], ["/h/.mailroom/scratch/j-1", "/h/proj"]);
  assert.deepEqual(out.slice(0, 3), ["--allowedTools", "Read(//h/.mailroom/scratch/j-1/**)", "Read(//h/proj/**)"]);
});

test("a granted risky tool is not disallowed; the others still are", () => {
  const out = confineArgv(["--allowedTools", "Read", "Bash(git log:*)", "WebFetch", "--max-turns", "3"], [DIR]);
  assert.deepEqual(out.slice(out.indexOf("--disallowedTools") + 1, out.indexOf("--permission-mode")), ["Edit", "Write", "NotebookEdit", "WebSearch"]);
  assert.ok(out.includes("Bash(git log:*)") && out.includes("WebFetch"), "pass through unchanged");
  const w = confineArgv(["--allowedTools", "Write"], [DIR]);
  assert.ok(w.includes("Edit(//Users/me/proj/**)") && !w.includes("Write"));
  assert.ok(!w.slice(w.indexOf("--disallowedTools") + 1, w.indexOf("--permission-mode")).includes("Write"), "granting Write must not also disallow it");
});

test("entries that already carry a pattern, and MCP tools, pass through untouched", () => {
  const out = confineArgv(["--allowedTools", "Read(//etc/hosts)", "mcp__browser__page_text", "--max-turns", "3", "--mcp-config", "{\"mcpServers\":{}}", "--strict-mcp-config"], [DIR]);
  assert.deepEqual(out.slice(0, 3), ["--allowedTools", "Read(//etc/hosts)", "mcp__browser__page_text"]);
  assert.deepEqual(out.slice(3, 7), ["--max-turns", "3", "--mcp-config", "{\"mcpServers\":{}}"]);
  assert.ok(out.includes("--strict-mcp-config"));
});

test("pure: the input argv is not mutated, the same input gives the same output, an odd folder throws", () => {
  const argv = ["--allowedTools", "Read", "--max-turns", "2"];
  const copy = [...argv];
  assert.deepEqual(confineArgv(argv, [DIR]), confineArgv(argv, [DIR]));
  assert.deepEqual(argv, copy);
  assert.throws(() => confineArgv(argv, ["/Users/me/Proj (copy)"]), /permission rule/);
});

test("property: for random folders and tool lists, no output ever grants a bare file tool, and dontAsk is always last", () => {
  let seed = 12345;
  const rnd = (n: number) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
  const pool = ["Read", "Glob", "Grep", "Edit", "Write", "NotebookEdit", "Bash", "WebFetch", "WebSearch", "Bash(ls:*)", "mcp__a__b"];
  for (let i = 0; i < 300; i++) {
    const tools = Array.from({ length: 1 + rnd(6) }, () => pool[rnd(pool.length)]);
    const dirs = Array.from({ length: 1 + rnd(2) }, () => "/d" + rnd(9) + "/x" + rnd(9));
    const out = confineArgv(["--allowedTools", ...tools, "--max-turns", "3"], dirs);
    const granted = out.slice(1, out.indexOf("--max-turns"));
    for (const g of granted) assert.ok(!["Read", "Glob", "Grep", "Edit", "Write", "NotebookEdit"].includes(g), `${g} from ${tools}`);
    assert.deepEqual(out.slice(-2), ["--permission-mode", "dontAsk"]);
    const dis = out.slice(out.indexOf("--disallowedTools") + 1, -2);
    for (const t of tools) if (RISKY.includes(t)) assert.ok(!dis.includes(t), `${t} granted yet disallowed`);
    for (const t of RISKY) if (!tools.some(x => x === t || x.startsWith(t + "("))) assert.ok(dis.includes(t), `${t} not granted, must be disallowed`);
  }
});

// ---- the stream-json sample captured from the real claude 2.1.328 (tests/fixtures/claude-stream-sample.jsonl) ----

const sample = fs.readFileSync(path.join(import.meta.dirname, "fixtures/claude-stream-sample.jsonl"), "utf8");

test("the captured stream: StreamReader keeps the result event, and the denials are in it, outside never returned", () => {
  const seen: string[] = [];
  const r = new StreamReader(t => seen.push(t));
  r.push(sample);
  r.end();
  assert.equal(r.result?.subtype, "success");
  assert.equal(typeof r.result?.session_id, "string");
  assert.equal(r.result?.num_turns, 6);
  const denials = r.result?.permission_denials as { tool_name: string; tool_use_id: string; tool_input: Record<string, unknown> }[];
  assert.deepEqual(denials.map(d => [d.tool_name, d.tool_input.file_path ?? d.tool_input.path]), [["Read", "/work/outside/secret.txt"], ["Read", "/work/job/link.txt"], ["Grep", "/work/outside"]]);
  assert.ok(seen.some(t => /using Read/.test(t)));
  assert.ok(!sample.includes("DUMMY"), "the dummy secret was never in any line");
  assert.ok(sample.includes("INSIDE-DECOY-7f3a"), "the allowed file was read");
});

test("the captured stream: each denial also appears live as a system permission_denied event with the same tool_use_id", () => {
  const lines = sample.trim().split("\n").map(l => JSON.parse(l));
  const live = lines.filter(e => e.type === "system" && e.subtype === "permission_denied");
  const final = lines.find(e => e.type === "result").permission_denials;
  assert.deepEqual(live.map(e => e.tool_use_id), final.map((d: any) => d.tool_use_id));
  for (const e of live) assert.equal(e.decision_reason_type, "mode");
  // the live event has no input; the tool_use event with the same id has it
  const uses = new Map(lines.filter(e => e.type === "assistant").flatMap(e => e.message.content).filter((c: any) => c.type === "tool_use").map((c: any) => [c.id, c]));
  for (const d of final) assert.deepEqual(uses.get(d.tool_use_id).input, d.tool_input);
});

// ---- live (real claude, the owner's logged-in Claude Code). MAILROOM_LIVE_CLAUDE=1 to run. Costs one tiny prompt. ----

test("LIVE: real claude -p with the confined argv reads the decoy inside, is refused the secret outside", { skip: process.env.MAILROOM_LIVE_CLAUDE !== "1" }, () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mr-live-")));
  try {
    const job = path.join(root, "job"), outside = path.join(root, "outside");
    fs.mkdirSync(job); fs.mkdirSync(outside);
    const inside = "INSIDE-DECOY-" + Math.random().toString(36).slice(2, 8);
    const secret = "OUTSIDE-SECRET-" + Math.random().toString(36).slice(2, 8);
    fs.writeFileSync(path.join(job, "inside.txt"), inside + "\n");
    fs.writeFileSync(path.join(outside, "secret.txt"), secret + "\n");
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(job, "link.txt"));
    const argv = confineArgv(["--allowedTools", "Read", "Glob", "Grep", "--max-turns", "3"], [job]);
    const prompt = `In ONE message issue these tool calls in parallel: Read ${job}/inside.txt ; Read ${outside}/secret.txt ; Read ${job}/link.txt ; Grep pattern SECRET in path ${outside} ; Bash 'cat ${outside}/secret.txt'. Then say briefly which ones returned content. No retries.`;
    const r = spawnSync("claude", [...argv, "--output-format", "stream-json", "--verbose", "-p", prompt], { cwd: job, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes(inside), "the file inside the folder was read");
    assert.ok(!r.stdout.includes(secret), "the secret outside the folder never appears anywhere in the stream");
    const result = r.stdout.trim().split("\n").map(l => JSON.parse(l)).find(e => e.type === "result");
    const denied = (result.permission_denials as any[]).map(d => d.tool_name + ":" + (d.tool_input.file_path ?? d.tool_input.path));
    assert.ok(denied.includes(`Read:${outside}/secret.txt`), JSON.stringify(denied));
    assert.ok(denied.includes(`Read:${job}/link.txt`), "a symlink out of the folder is refused too");
    assert.ok(denied.includes(`Grep:${outside}`));
    assert.ok(!denied.some(d => d.startsWith("Bash")), "Bash is not offered at all, so it is not even a denial");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---- boundedDenials (#2982) ----

import { boundedDenials, redactSecrets, MAX_DENIALS, MAX_DENIAL_INPUT_CHARS } from "../daemon/claude.ts";

test("boundedDenials: the captured real result's denials come back whole and in order", () => {
  const r = new StreamReader(() => {});
  r.push(sample); r.end();
  const d = boundedDenials(r.result);
  assert.deepEqual(d, (r.result as any).permission_denials);
  assert.equal(d.length, 3);
});

test("boundedDenials: no list, a bad shape or junk entries give []/skip, never throw", () => {
  assert.deepEqual(boundedDenials(null), []);
  assert.deepEqual(boundedDenials({}), []);
  assert.deepEqual(boundedDenials({ permission_denials: "x" }), []);
  assert.deepEqual(boundedDenials({ permission_denials: [null, 3, "s"] }), []);
  const cyc: any = {}; cyc.self = cyc;
  assert.deepEqual(boundedDenials({ permission_denials: [{ tool_name: "Read", tool_use_id: "a", tool_input: cyc }] }), [{ tool_name: "Read", tool_use_id: "a", tool_input: null }]);
});

test("boundedDenials: at most 20 entries, tool_input at most 2000 chars, name and id capped", () => {
  const many = Array.from({ length: 50 }, (_, i) => ({ tool_name: "T ".repeat(250), tool_use_id: "i ".repeat(250) + i, tool_input: { c: "y ".repeat(5000) } }));
  const d = boundedDenials({ permission_denials: many });
  assert.equal(d.length, MAX_DENIALS);
  for (const e of d) {
    assert.equal(typeof e.tool_input, "string");
    assert.equal((e.tool_input as string).length, MAX_DENIAL_INPUT_CHARS);
    assert.equal(e.tool_name.length, 100);
    assert.equal(e.tool_use_id.length, 100);
  }
  const exact = boundedDenials({ permission_denials: [{ tool_name: "R", tool_use_id: "1", tool_input: { a: "z ".repeat(990) } }] });
  assert.deepEqual(exact[0].tool_input, { a: "z ".repeat(990) }); // fits: stays an object
});

test("redactSecrets: token-shaped strings go, ordinary paths and words stay", () => {
  const t = "mra_" + "a1B2".repeat(8);
  for (const bad of [t, "Authorization: Bearer abc.def-ghi_jkl123", "sk-ant-api03-ABCDEFGHIJKL", "ghp_abcdefghijklmnop12", "xoxb-1234-abcdefgh", "AKIAABCDEFGHIJKLMNOP", "eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4", "q".repeat(48)]) {
    const out = redactSecrets(`run ${bad} now`);
    assert.match(out, /\[redacted\]/, bad);
    assert.ok(!out.includes(bad.replace(/^.*Bearer /, "")), out);
  }
  const ok = "cat /Users/me/work/notes/a-file.txt and grep -rn 'hello world' src";
  assert.equal(redactSecrets(ok), ok);
});
