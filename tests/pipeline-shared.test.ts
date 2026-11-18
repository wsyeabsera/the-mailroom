import { test } from "node:test";
import assert from "node:assert/strict";
import { check, validateContract } from "../shared/contract.ts";
import type { Contract } from "../shared/contract.ts";
import { checkBatch, checkWorkflow, clipValue, effectiveConcurrency } from "../shared/pipeline.ts";
import { getPath, isEmpty, parseWorkflow, resolveRef, resolveValue, toArg, whenHolds } from "../shared/workflow.ts";
import { estimateFits, parseEstimate } from "../shared/estimate.ts";
import { refusedWhenOver, usesBudget } from "../shared/claude-budget.ts";

const C: Contract = { name: "t", folders: ["~/x"], tasks: ["batch", "workflow"], dailyLimit: 10, expires: null, approval: [], commands: ["scan"], prompts: ["answer"], batches: ["run:scan", "ask:answer"], batchMaxItems: 5, batchMaxConcurrency: 2, workflows: ["wf"] };
const now = Date.now();
const ctx = { now, usedToday: 0 };

test("batch: target, items and concurrency come from the contract", () => {
  assert.equal(check(C, { task: "batch", args: { prompt: "answer", items: [{ q: "a" }] } }, ctx).verdict, "allow");
  const refuse = (args: Record<string, unknown>) => { const v = check(C, { task: "batch", args }, ctx); return v.verdict === "refuse" ? v.reason : "allowed"; };
  assert.match(refuse({ command: "other", items: [{}] }), /not in the contract/);
  assert.match(refuse({ command: "scan", prompt: "answer", items: [{}] }), /exactly one/);
  assert.match(refuse({ command: "scan", items: [] }), /non-empty/);
  assert.match(refuse({ command: "scan", items: [{}, {}, {}, {}, {}, {}] }), /at most 5/);
  assert.match(refuse({ command: "scan", items: ["x"] }), /must be an object/);
  assert.match(refuse({ command: "scan", items: [{}], concurrency: 3 }), /contract allows \(2\)/);
  assert.match(refuse({ command: "scan", items: [{}], concurrency: 9 }), /1 to 6/);
  assert.match(refuse({ command: "scan", items: [{}], cwd: "/" }), /takes only/);
  // a target also has to be in the single-job list
  assert.match(String(checkBatch({ ...C, commands: [] }, { command: "scan", items: [{}] })), /command “scan” is not in the contract/);
});

test("workflow: only a named workflow of the contract, inputs an object", () => {
  assert.equal(check(C, { task: "workflow", args: { name: "wf", inputs: { a: 1 } } }, ctx).verdict, "allow");
  assert.match(String(checkWorkflow(C, { name: "nope" })), /not in the contract/);
  assert.match(String(checkWorkflow(C, { name: "wf", inputs: [] })), /must be an object/);
  assert.match(String(checkWorkflow(C, { name: "wf", cwd: "/" })), /takes only/);
  assert.equal(check({ ...C, tasks: ["echo"] }, { task: "workflow", args: { name: "wf" } }, ctx).verdict, "refuse");
});

test("validateContract keeps batches, limits and workflows and asks for them when the task is allowed", () => {
  const base = { name: "t", folders: ["~/x"], dailyLimit: 5, commands: ["scan"], prompts: ["answer"] };
  const ok = validateContract({ ...base, tasks: ["batch", "workflow"], batches: ["run:scan"], workflows: ["wf"], batchMaxItems: 20, batchMaxConcurrency: 4 });
  assert.ok(ok.ok && ok.contract.batches?.[0] === "run:scan" && ok.contract.batchMaxItems === 20 && ok.contract.workflows?.[0] === "wf");
  const none = validateContract({ ...base, tasks: ["batch"] });
  assert.ok(!none.ok && none.errors.batches);
  const bad = validateContract({ ...base, tasks: ["batch"], batches: ["scan"], batchMaxConcurrency: 7 });
  assert.ok(!bad.ok && bad.errors.batches && bad.errors.batchMaxConcurrency);
  assert.ok(!validateContract({ ...base, tasks: ["workflow"] }).ok);
  const plain = validateContract({ ...base, tasks: ["echo"] });
  assert.ok(plain.ok && plain.contract.batchMaxItems === 100 && plain.contract.batchMaxConcurrency === 3);
});

test("concurrency: default 3, never above the hard maximum or any ceiling", () => {
  assert.equal(effectiveConcurrency(undefined), 3);
  assert.equal(effectiveConcurrency(9), 6);
  assert.equal(effectiveConcurrency(5, 4), 4);
  assert.equal(effectiveConcurrency(5, 4, 2, undefined), 2);
});

test("budget rules: batch of prompts and workflows count; only Claude-only jobs are refused when it is spent", () => {
  assert.ok(usesBudget("batch", { prompt: "a" }) && !usesBudget("batch", { command: "a" }) && usesBudget("workflow", {}) && usesBudget("ask", {}));
  assert.ok(refusedWhenOver("batch", { prompt: "a" }) && !refusedWhenOver("workflow", {}) && !refusedWhenOver("run", {}));
});

test("clipValue keeps a small value and replaces a big one with a marker", () => {
  assert.deepEqual(clipValue({ a: 1 }, 100), { a: 1 });
  assert.deepEqual(clipValue({ a: "x".repeat(200) }, 100), { truncated: true, bytes: 208 });
  assert.equal(String(clipValue("y".repeat(50), 10)).length, 10);
});

test("references: whole-string paths into inputs and earlier steps; no expressions", () => {
  const scope = { inputs: { n: 2 }, list: { items: ["a", "b"], 0: "zero" } };
  assert.deepEqual(resolveRef("$list.items", scope), ["a", "b"]);
  assert.equal(resolveRef("$list.items.1", scope), "b");
  assert.equal(resolveRef("$list.nope.deeper", scope), undefined);
  assert.equal(resolveRef("$list.constructor", scope), undefined); // own properties only
  assert.equal(resolveRef("$inputs.n", scope), 2);
  assert.equal(resolveValue("plain", scope), "plain");
  assert.equal(resolveValue("$$list.items", scope), "$list.items");
  assert.equal(resolveValue("$5", scope), "$5"); // not a reference
  assert.equal(toArg({ a: 1 }), '{"a":1}');
  assert.equal(toArg("s"), "s");
  assert.ok(isEmpty([]) && isEmpty("") && isEmpty({}) && isEmpty(null) && !isEmpty(0) && !isEmpty(false) && !isEmpty([0]));
  assert.ok(whenHolds("$list.items", scope) && !whenHolds("!$list.items", scope) && whenHolds("!$list.missing", scope) && whenHolds(undefined, scope));
  assert.equal(getPath({ a: [{ b: 1 }] }, "a.0.b"), 1);
});

test("parseWorkflow accepts the documented shape and refuses what it cannot check", () => {
  const good = { inputs: { topic: { type: "string", required: true } }, estimate: { minutes: 6, claudeTurns: 40 }, budget: { turns: 50, minutes: 10 }, steps: [
    { id: "list", run: "list-items", args: { topic: "$inputs.topic" } },
    { id: "ask", batch: "ask:answer", items: "$list.items", with: { q: "$item" }, concurrency: 3 },
    { id: "check", run: "check", stdin: "$ask", when: "$list.items" },
  ] };
  const r = parseWorkflow("wf", good);
  assert.ok("workflow" in r);
  if ("workflow" in r) {
    assert.equal(r.workflow.steps.length, 3);
    assert.deepEqual(r.workflow.estimate, { minutes: 6, claudeTurns: 40 });
    assert.deepEqual(r.workflow.budget, { turns: 50, minutes: 10 });
  }
  const err = (w: unknown) => ("error" in parseWorkflow("wf", w) ? (parseWorkflow("wf", w) as { error: string }).error : "ok");
  assert.match(err({ steps: [] }), /1 to 30 steps/);
  assert.match(err({ steps: [{ id: "a", run: "x" }, { id: "a", run: "y" }] }), /two steps named/);
  assert.match(err({ steps: [{ id: "a", run: "x", ask: "y" }] }), /exactly one/);
  assert.match(err({ steps: [{ id: "a", run: "x", args: { v: "$later.x" } }, { id: "later", run: "y" }] }), /not an earlier step/);
  assert.match(err({ steps: [{ id: "a", run: "x", args: { v: "$item" } }] }), /may not use \$item/);
  assert.match(err({ steps: [{ id: "a", run: "x", args: { v: { nested: 1 } } }] }), /value or a \$reference/);
  assert.match(err({ steps: [{ id: "a", batch: "bad", items: "$inputs.x" }] }), /bad batch target/);
  assert.match(err({ steps: [{ id: "a", run: "x", args: { v: "$inputs.undeclared" } }] }), /not declared/);
  assert.match(err({ steps: [{ id: "item", run: "x" }] }), /needs an id/);
  assert.match(err({ steps: [{ id: "a", run: "x", when: "nonsense" }] }), /when/);
  assert.match(err({ steps: [{ id: "a", run: "x", stdin: "plain" }] }), /reference/);
  assert.match(err({ steps: [{ id: "a", ask: "x", stdin: "$inputs.x" }], inputs: { x: { type: "string" } } }), /stdin belongs to run/);
});

test("estimates: cleaned, and compared with what is left of the budget", () => {
  assert.deepEqual(parseEstimate({ minutes: 6.04, claudeTurns: 40.4, junk: 1 }), { minutes: 6, claudeTurns: 40 });
  assert.equal(parseEstimate({ minutes: -1 }), undefined);
  assert.equal(parseEstimate("6 minutes"), undefined);
  assert.equal(estimateFits(undefined, { turnsLeft: 0, msLeft: 0 }).fits, true);
  assert.equal(estimateFits({ claudeTurns: 40 }, { turnsLeft: 100, msLeft: 1e9 }).fits, true);
  assert.match(estimateFits({ claudeTurns: 40 }, { turnsLeft: 10, msLeft: 1e9 }).warning!, /only 10 are left/);
  assert.match(estimateFits({ minutes: 6 }, { turnsLeft: 10, msLeft: 60_000 }).warning!, /only 1 are left/);
});
