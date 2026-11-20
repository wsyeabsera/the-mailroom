import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { recheck } from "../daemon/tasks.ts";
import { savePolicy, resetPolicyWarning } from "../daemon/policy.ts";

const CLI = path.resolve(import.meta.dirname, "../daemon/cli.ts");
const mk = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mr-pol-")));
const contract = (folders: string[], tasks: string[], extra: object = {}) =>
  ({ name: "k", folders, tasks, dailyLimit: 10, expires: null, approval: [], ...extra }) as any;
const job = (c: any, task: string, args: any) => ({ id: "j", task, args, contract: c });

test("no policy file: current behaviour, warns once", () => {
  const home = mk();
  const warns: string[] = [];
  const orig = console.warn;
  console.warn = (m: string) => warns.push(m);
  resetPolicyWarning();
  try {
    const r1 = recheck(job(contract([home], ["read_file"]), "read_file", { path: path.join(home, "a") }), Date.now(), home);
    recheck(job(contract([home], ["echo"]), "echo", {}), Date.now(), home);
    assert.ok("resolved" in r1);
  } finally { console.warn = orig; }
  assert.equal(warns.length, 1);
});

test("widened contract is refused by the laptop policy", () => {
  const home = mk();
  const ok = path.join(home, "proj");
  fs.mkdirSync(ok);
  savePolicy({ folders: [ok], tasks: ["read_file", "echo"] }, home);
  const t = (c: any, task: string, args: any) => recheck(job(c, task, args), Date.now(), home);
  assert.ok("resolved" in t(contract([ok], ["read_file"]), "read_file", { path: path.join(ok, "f") }));
  assert.match((t(contract([home], ["read_file"]), "read_file", { path: path.join(ok, "f") }) as any).reason, /outside the laptop policy/);
  assert.match((t(contract([ok], ["echo", "claude"]), "echo", {}) as any).reason, /claude/);
  assert.match((t(contract([ok], ["claude"]), "claude", { cwd: ok, prompt: "x" }) as any).reason, /not allowed by the laptop policy/);
  assert.match((t(contract([ok], ["echo"], { commands: ["rm"] }), "echo", {}) as any).reason, /commands rm/);
  assert.match((t(contract([ok], ["echo"], { commands: ["rm"] }), "echo", {}) as any).reason, /mailroom policy allow-command rm/);
  assert.match((t(contract([home], ["read_file"]), "read_file", { path: path.join(ok, "f") }) as any).reason, new RegExp(`mailroom policy allow-folder ${home}`));
  assert.match((t(contract([ok], ["echo", "claude"]), "echo", {}) as any).reason, /mailroom policy allow-task claude/);
  // symlink inside the policy folder pointing out
  const out = path.join(home, "secret");
  fs.mkdirSync(out);
  fs.symlinkSync(out, path.join(ok, "link"));
  assert.ok("reason" in t(contract([path.join(ok, "link")], ["read_file"]), "read_file", { path: path.join(ok, "link", "f") }));
});

test("malformed policy fails closed; policy is reloaded per job", () => {
  const home = mk();
  fs.mkdirSync(path.join(home, ".mailroom"));
  fs.writeFileSync(path.join(home, ".mailroom", "policy.json"), "{nope");
  assert.match((recheck(job(contract([home], ["echo"]), "echo", {}), Date.now(), home) as any).reason, /policy unusable/);
  savePolicy({ folders: [home], tasks: ["echo"] }, home);
  assert.ok("resolved" in recheck(job(contract([home], ["echo"]), "echo", {}), Date.now(), home));
});

test("mailroom policy CLI", () => {
  const home = mk();
  const run = (...a: string[]) => spawnSync(process.execPath, [CLI, "policy", ...a], { env: { ...process.env, HOME: home }, encoding: "utf8" });
  assert.match(run("show").stdout, /not set/);
  assert.equal(run("allow-folder", "~/work").status, 0);
  assert.equal(run("allow-task", "echo").status, 0);
  const file = path.join(home, ".mailroom", "policy.json");
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { folders: ["~/work"], tasks: ["echo"] });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(run("allow-task", "mcp_list").status, 0);
  assert.equal(run("allow-task", "mcp_call").status, 0);
  assert.equal(run("allow-task", "mcp_call").status, 0); // twice: still one entry
  const bogus = run("allow-task", "mcp_everything");
  assert.notEqual(bogus.status, 0);
  assert.match(bogus.stderr + bogus.stdout, /not a task.*mcp_list, mcp_call/);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).tasks, ["echo", "mcp_list", "mcp_call"]);
  assert.equal(run("allow-command", "deploy-notes").status, 0);
  assert.notEqual(run("allow-command", "bad name;").status, 0);
  assert.equal(run("allow-claude-tool", "Bash(git log:*)").status, 0);
  assert.equal(run("claude-max-turns", "20").status, 0);
  assert.notEqual(run("claude-max-turns", "99").status, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { folders: ["~/work"], tasks: ["echo", "mcp_list", "mcp_call"], commands: ["deploy-notes"], claudeTools: ["Read", "Glob", "Grep", "Bash(git log:*)"], claudeMaxTurns: 20 });
  const shown = run("show").stdout;
  assert.match(shown, /commands: deploy-notes/);
  assert.match(shown, /claude max turns: 20/);
});

test("claude ceilings in the laptop policy", () => {
  const home = mk();
  const ok = path.join(home, "proj");
  fs.mkdirSync(ok);
  savePolicy({ folders: [ok], tasks: ["claude"] }, home);
  const t = (c: any, args: any = {}) => recheck(job(c, "claude", { prompt: "x", cwd: ok, ...args }), Date.now(), home) as any;
  assert.ok("resolved" in t(contract([ok], ["claude"]))); // defaults fit the default policy
  assert.match(t(contract([ok], ["claude"], { claudeTools: ["Read", "Bash"] }), {}).reason, /allow-claude-tool 'Bash'/);
  assert.match(t(contract([ok], ["claude"], { claudeMaxTurns: 50 }), { maxTurns: 50 }).reason, /claude-max-turns 50/);
  savePolicy({ folders: [ok], tasks: ["claude"], claudeTools: ["Read", "Bash"], claudeMaxTurns: 50 }, home);
  assert.ok("resolved" in t(contract([ok], ["claude"], { claudeTools: ["Read", "Bash"], claudeMaxTurns: 50 }), { allowedTools: ["Bash"], maxTurns: 50 }));
});
