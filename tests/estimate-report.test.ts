import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { commandsView, sanitizePromptReport, sanitizeReport, sanitizeWorkflowReport } from "../shared/projects.ts";
import { listReport } from "../daemon/commands.ts";
import { listPromptReport } from "../daemon/prompts.ts";
import { listWorkflowReport, loadWorkflow } from "../daemon/workflows.ts";
import { tmpHome } from "./daemon-helpers.ts";

test("the laptop reports estimates for commands, prompts and workflows, and workflows without their steps", () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, ".mailroom"));
  const w = (f: string, v: unknown) => fs.writeFileSync(path.join(home, ".mailroom", f), JSON.stringify(v), { mode: 0o600 });
  w("commands.json", { scan: { script: "/bin/echo", cwd: home, estimate: { minutes: 2 } }, plain: { script: "/bin/echo", cwd: home } });
  w("prompts.json", { ask1: { template: "x", cwd: home, estimate: { minutes: 1, claudeTurns: 5 } } });
  w("workflows.json", { wf: { inputs: { t: { type: "string" } }, estimate: { minutes: 6, claudeTurns: 40 }, steps: [{ id: "a", run: "scan" }] }, broken: { steps: [] } });
  assert.deepEqual(listReport(home).map(c => [c.name, c.estimate]), [["scan", { minutes: 2 }], ["plain", undefined]]);
  assert.deepEqual(listPromptReport(home)[0].estimate, { minutes: 1, claudeTurns: 5 });
  const rep = listWorkflowReport(home);
  assert.equal(rep.length, 1); // the broken one is not reported
  assert.deepEqual(rep[0], { name: "wf", inputs: { t: { type: "string", required: false, maxLength: undefined, values: undefined } }, steps: 1, timeoutMs: 30 * 60_000, estimate: { minutes: 6, claudeTurns: 40 } });
  assert.ok(!JSON.stringify(rep).includes("scan")); // never the steps
  assert.match((loadWorkflow("broken", home) as { error: string }).error, /1 to 30 steps/);
  assert.match((loadWorkflow("ghost", home) as { error: string }).error, /not registered/);
  fs.chmodSync(path.join(home, ".mailroom/workflows.json"), 0o644);
  assert.match((loadWorkflow("wf", home) as { error: string }).error, /mode 0600/);
  assert.deepEqual(listWorkflowReport(home), []);
});

test("the Hub sanitises the reports: bad estimates and shapes are dropped", () => {
  const c = sanitizeReport([{ name: "a", args: {}, estimate: { minutes: "six", claudeTurns: 3 } }, { name: "b", args: {}, estimate: 5 }]);
  assert.deepEqual(c.map(x => x.estimate), [{ claudeTurns: 3 }, undefined]);
  assert.deepEqual(sanitizePromptReport([{ name: "p", estimate: { minutes: 2 } }])[0].estimate, { minutes: 2 });
  const w = sanitizeWorkflowReport([{ name: "w", inputs: { a: { type: "string" }, "bad name!": { type: "string" } }, steps: 3, timeoutMs: 5000, estimate: { claudeTurns: 9 } }, { name: "../x" }, "junk"]);
  assert.equal(w.length, 1);
  assert.deepEqual(Object.keys(w[0].inputs), ["a"]);
  assert.deepEqual(w[0].estimate, { claudeTurns: 9 });
});

test("the Commands view carries the estimate of a reported command", () => {
  const v = commandsView({ projectId: "pr_1", projects: [{ id: "pr_1", archived: false }], reported: sanitizeReport([{ name: "a", args: {}, estimate: { minutes: 4 } }, { name: "b", args: {} }]), keyContracts: [{ keyId: "k1", commands: ["a", "b"] }] });
  assert.deepEqual(v.rows.map(r => r.estimate), [{ minutes: 4 }, undefined]);
});
