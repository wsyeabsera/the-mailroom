import { test } from "node:test";
import assert from "node:assert/strict";
import { validateProject, sanitizeReport, commandsView } from "../shared/projects.ts";

test("validateProject: name rules", () => {
  const r: any = validateProject({ name: " " });
  assert.equal(r.ok, false);
  assert.ok(r.errors.name);
  assert.equal((validateProject({ name: "x".repeat(61) }) as any).ok, false);
  assert.equal(validateProject({ name: "x".repeat(60) }).ok, true);
  assert.equal(validateProject(null).ok, false);
});

test("validateProject: folder, notes, color", () => {
  assert.ok((validateProject({ name: "a", folder: "notes" }) as any).errors.folder);
  const ok: any = validateProject({ name: " a ", folder: "~/Hobby/x", color: "#aabbcc" });
  assert.equal(ok.ok, true);
  assert.equal(ok.project.name, "a");
  assert.equal(ok.project.folder, "~/Hobby/x");
  assert.ok((validateProject({ name: "a", notes: "n".repeat(2001) }) as any).errors.notes);
  assert.ok((validateProject({ name: "a", color: "red" }) as any).errors.color);
  assert.deepEqual((validateProject({ name: "a" }) as any).project, { name: "a", folder: null, notes: "", color: null });
});

test("sanitizeReport: limits and junk", () => {
  const many = Array.from({ length: 500 }, (_, i) => ({ name: `c${i}` }));
  assert.equal(sanitizeReport(many).length, 200);
  assert.deepEqual(sanitizeReport([{ name: "a b" }, 5, null]), []);
  assert.deepEqual(sanitizeReport("nope"), []);
  assert.deepEqual(sanitizeReport([{ name: "x".repeat(10000) }]), []);
  const r = sanitizeReport([{ name: "a", project: "pr_1000" }, { name: "b", project: 7 }]);
  assert.equal(r[0].project, "pr_1000");
  assert.equal(r[1].project, null);
});

test("sanitizeReport: arg specs are capped and cleaned", () => {
  const args: Record<string, unknown> = {};
  for (let i = 0; i < 30; i++) args[`a${i}`] = { type: "string" };
  args["bad name"] = { type: "string" };
  const r = sanitizeReport([{ name: "c", args, timeoutMs: 1000, script: "/x", cwd: "/y" }]);
  assert.equal(Object.keys(r[0].args).length, 20);
  assert.equal(r[0].timeoutMs, 1000);
  assert.equal("script" in r[0], false);
  const e = sanitizeReport([{ name: "c", args: { k: { type: "enum", values: [...Array(80).fill("v"), "x".repeat(101), 5] }, z: { type: "weird" } } }]);
  assert.equal(e[0].args.k.values!.length, 50);
  assert.equal(e[0].args.z, undefined);
});

const projects = [
  { id: "pr_1000", archived: false },
  { id: "pr_1001", archived: false },
  { id: "pr_1002", archived: true },
];
const rep = (name: string, project: string | null) => ({ name, project, args: {}, timeoutMs: null });

test("commandsView: mismatch kinds", () => {
  const v = commandsView({
    projectId: "pr_1000",
    projects,
    reported: [rep("mine", "pr_1000"), rep("other", "pr_1001"), rep("ghost", "pr_9999"), rep("old", "pr_1002"), rep("plain", null)],
    keyContracts: [{ keyId: "k1", commands: ["other", "ghost", "old", "plain", "missing"] }],
  });
  assert.equal(v.reported, true);
  const m = Object.fromEntries(v.rows.map((r) => [r.name, r.mismatch]));
  assert.equal(m.mine, null);
  assert.equal(m.other, "other-project");
  assert.equal(m.ghost, "unknown-project");
  assert.equal(m.old, "unknown-project");
  assert.equal(m.plain, null);
  assert.equal(m.missing, "not-on-laptop");
  assert.deepEqual(v.rows.find((r) => r.name === "other")!.viaKeys, ["k1"]);
  assert.equal(v.rows.find((r) => r.name === "missing")!.onLaptop, false);
});

test("commandsView: not reported", () => {
  const v = commandsView({ projectId: "pr_1000", projects, reported: null, keyContracts: [{ keyId: "k", commands: ["a"] }] });
  assert.equal(v.reported, false);
  assert.deepEqual(v.rows, [{ name: "a", onLaptop: false, taggedTo: null, viaKeys: ["k"], mismatch: null }]);
});
