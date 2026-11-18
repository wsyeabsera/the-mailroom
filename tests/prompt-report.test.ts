import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { PROMPT_REPORT_TABLE, loadPromptReport, storePromptReport } from "../src/prompt-report.ts";
import { sanitizePromptReport } from "../shared/projects.ts";
import type { Sql } from "../src/login-limit.ts";

function mk(): Sql {
  const db = new DatabaseSync(":memory:");
  db.exec(PROMPT_REPORT_TABLE);
  return { all: <T>(q: string, ...p: unknown[]) => db.prepare(q).all(...(p as never[])) as T[], run: (q: string, ...p: unknown[]) => void db.prepare(q).run(...(p as never[])) };
}

test("the Hub stores the laptop's prompt report, sanitised, as the last snapshot", () => {
  const sql = mk();
  assert.equal(loadPromptReport(sql), null);
  storePromptReport(sql, [{ name: "find-stream", vars: { name: { type: "string", required: true, maxLength: 80 } }, timeoutMs: 1000, schema: true, template: "SECRET", evil: 1 }, { name: "bad name!" }, "x", { name: "find-stream" }], 5);
  const r = loadPromptReport(sql)!;
  assert.equal(r.reported_at, 5);
  assert.deepEqual(r.prompts, [{ name: "find-stream", vars: { name: { type: "string", required: true, maxLength: 80 } }, timeoutMs: 1000, schema: true }]);
  assert.ok(!JSON.stringify(r).includes("SECRET"));
  storePromptReport(sql, "garbage", 9); // never throws; replaces with nothing usable
  assert.deepEqual(loadPromptReport(sql)!.prompts, []);
});

test("sanitizePromptReport: junk in, nothing out; caps variables", () => {
  assert.deepEqual(sanitizePromptReport(undefined), []);
  assert.deepEqual(sanitizePromptReport({}), []);
  const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`v${i}`, { type: "boolean" }]));
  assert.equal(Object.keys(sanitizePromptReport([{ name: "a", vars: many }])[0].vars).length, 20);
});
