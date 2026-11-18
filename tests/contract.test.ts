import test from "node:test";
import assert from "node:assert/strict";
import { check, normalizePath, validateContract, type Contract } from "../shared/contract.ts";

const notes: Contract = { name: "Notes writer", folders: ["~/Hobby/dunder/notes"], tasks: ["echo", "read_file", "write_file"], dailyLimit: 50, expires: null, approval: ["write_file"] };
const ctx = { now: Date.parse("2026-11-15T12:00:00Z"), usedToday: 0 };

test("normalizePath: tilde, dots and slashes", () => {
  assert.equal(normalizePath("~/a/../b"), "~/b");
  assert.equal(normalizePath("/a//b/"), "/a/b");
  assert.equal(normalizePath("~/a", "/Users/yab"), "/Users/yab/a");
  assert.equal(normalizePath("~/../x"), null);
  assert.equal(normalizePath("notes/x"), null);
  assert.equal(normalizePath(""), null);
});

test("echo is allowed and touches no path", () => {
  assert.deepEqual(check(notes, { task: "echo", args: { text: "hi" } }, ctx), { verdict: "allow" });
});

test("a path inside the folder is allowed; write_file waits for approval", () => {
  assert.deepEqual(check(notes, { task: "read_file", args: { path: "~/Hobby/dunder/notes/a.md" } }, ctx), { verdict: "allow" });
  assert.deepEqual(check(notes, { task: "write_file", args: { path: "~/Hobby/dunder/notes/a.md", content: "x" } }, ctx), { verdict: "approve" });
});

test("a path outside the folder is refused, including sibling-prefix and dot-dot tricks", () => {
  for (const path of ["~/Documents/taxes/2025.pdf", "~/Hobby/dunder/notes-evil/a", "~/Hobby/dunder/notes/../secrets", "/etc/passwd", "relative/x"]) {
    const v = check(notes, { task: "read_file", args: { path } }, ctx);
    assert.equal(v.verdict, "refuse", path);
  }
});

test("task not in the contract, expired, over the daily limit", () => {
  assert.equal(check(notes, { task: "claude", args: { cwd: "~/Hobby/dunder/notes" } }, ctx).verdict, "refuse");
  assert.equal(check({ ...notes, expires: "2026-11-01T00:00:00.000Z" }, { task: "echo", args: {} }, ctx).verdict, "refuse");
  assert.equal(check(notes, { task: "echo", args: {} }, { ...ctx, usedToday: 50 }).verdict, "refuse");
  assert.equal(check(notes, { task: "echo", args: {} }, { ...ctx, usedToday: 49 }).verdict, "allow");
});

test("the daemon passes home and gets the same answer for an expanded path", () => {
  const home = "/Users/yab";
  assert.equal(check(notes, { task: "read_file", args: { path: "/Users/yab/Hobby/dunder/notes/a.md" } }, { ...ctx, home }).verdict, "allow");
  assert.equal(check(notes, { task: "read_file", args: { path: "/Users/yab/Documents/x" } }, { ...ctx, home }).verdict, "refuse");
});

test("claude needs a cwd inside the contract", () => {
  const c: Contract = { ...notes, tasks: ["claude"], approval: [] };
  assert.equal(check(c, { task: "claude", args: { prompt: "x" } }, ctx).verdict, "refuse");
  assert.equal(check(c, { task: "claude", args: { prompt: "x", cwd: "~/Hobby/dunder/notes" } }, ctx).verdict, "allow");
});

test("validateContract returns the editor's messages", () => {
  const bad = validateContract({ name: "Notes writer", folders: ["notes/dunder"], tasks: ["echo"], dailyLimit: "fifty", approval: [] });
  assert.equal(bad.ok, false);
  if (!bad.ok) {
    assert.match(bad.errors.folders, /Folders must start with ~\/ or \//);
    assert.equal(bad.errors.dailyLimit, "Use a whole number, like 50.");
  }
  const good = validateContract({ name: "Scratch", folders: ["~/scratch/"], tasks: ["echo"], dailyLimit: 20, expires: "", approval: [] });
  assert.equal(good.ok, true);
  if (good.ok) assert.deepEqual(good.contract.folders, ["~/scratch"]);
  assert.equal(validateContract({ name: "x", folders: ["/"], tasks: ["echo"], dailyLimit: 1 }).ok, false); // never the whole disk
});

test("run: commands are validated, required with run, and the job must name one the contract lists", () => {
  const base = { name: "R", folders: ["~/x"], tasks: ["run"], dailyLimit: 5, expires: null, approval: [] };
  const bad = validateContract({ ...base });
  assert.ok(!bad.ok && bad.errors.commands);
  const bad2 = validateContract({ ...base, commands: ["a b"] });
  assert.ok(!bad2.ok && bad2.errors.commands);
  const good = validateContract({ ...base, commands: ["deploy-notes", "x.y"] });
  assert.ok(good.ok);
  const c = (good as { ok: true; contract: Contract }).contract;
  assert.deepEqual(check(c, { task: "run", args: { command: "x.y", args: {} } }, ctx), { verdict: "allow" });
  assert.equal(check(c, { task: "run", args: { command: "other" } }, ctx).verdict, "refuse");
  assert.equal(check(c, { task: "run", args: {} }, ctx).verdict, "refuse");
  const old = { ...c } as Contract;
  delete old.commands; // a contract stored before commands existed
  assert.equal(check(old, { task: "run", args: { command: "x.y" } }, ctx).verdict, "refuse");
  assert.ok(validateContract({ ...base, tasks: ["echo"] }).ok);
});
