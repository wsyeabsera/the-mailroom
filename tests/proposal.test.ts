import test from "node:test";
import assert from "node:assert/strict";
import { diffContracts, isWidening } from "../shared/proposal.ts";
import { validateContract, type Contract } from "../shared/contract.ts";
import { Proposals, PROPOSAL_TABLE, MAX_PENDING_PROPOSALS } from "../src/proposals.ts";
import { validateTokenInput } from "../src/keys.ts";
import { DatabaseSync } from "node:sqlite";

const base = (o: Record<string, unknown> = {}): Contract => {
  const v = validateContract({ name: "Docs", folders: ["~/docs"], tasks: ["echo", "read_file"], dailyLimit: 10, approval: [], ...o });
  if (!v.ok) throw new Error(JSON.stringify(v.errors));
  return v.contract;
};
const d = (o: Record<string, unknown>) => diffContracts(base(), base(o));

test("diff: plain words, and nothing for identical contracts", () => {
  assert.deepEqual(diffContracts(base(), base()), []);
  const c = d({ tasks: ["echo", "read_file", "ask"], prompts: ["summarise"] });
  assert.deepEqual(c.map((x) => x.text), ["Adds the task “ask”.", "Adds the prompt “summarise”."]);
  assert.equal(isWidening(c), false);
});

test("widening: folders outside the old ones, write_file, claude, budgets, fewer approvals", () => {
  assert.equal(isWidening(d({ folders: ["~/docs", "~/other"] })), true);
  assert.equal(isWidening(d({ folders: ["~/docs", "~/docs/sub"] })), false);
  assert.equal(isWidening(d({ tasks: ["echo", "read_file", "write_file"] })), true);
  assert.equal(isWidening(d({ tasks: ["echo", "read_file", "claude"] })), true);
  assert.equal(isWidening(d({ tasks: ["echo"] })), false);
  assert.equal(isWidening(d({ dailyLimit: 11 })), true);
  assert.equal(isWidening(d({ dailyLimit: 5 })), false);
  assert.equal(isWidening(d({ claudeDailyTurns: 500 })), true);
  assert.equal(isWidening(d({ claudeMaxTurns: 20 })), true);
  assert.equal(isWidening(d({ claudeTools: ["Read", "Glob", "Grep", "Bash"] })), true);
  const withAppr = diffContracts(base({ tasks: ["echo", "write_file"], approval: ["write_file"] }), base({ tasks: ["echo", "write_file"], approval: [] }));
  assert.equal(isWidening(withAppr), true);
  assert.match(withAppr[0].text, /no longer be asked first/);
});

test("token scopes accept propose and add read", () => {
  const v = validateTokenInput({ label: "x", scopes: ["propose"] });
  assert.ok(v.ok && v.scopes.join() === "read,propose");
});

// ---- the Hub-side store, on an in-memory sqlite ----
function store() {
  const db = new DatabaseSync(":memory:");
  const sql = { all: <T>(q: string, ...p: any[]) => db.prepare(q).all(...p) as T[], run: (q: string, ...p: any[]) => void db.prepare(q).run(...p) };
  db.exec(PROPOSAL_TABLE);
  const events: [string, any][] = [];
  let n = 0;
  const cur = { body: base(), version: 1 };
  const saved: unknown[] = [];
  const p = new Proposals({
    sql, next: () => n++, event: (k, pl) => void events.push([k, pl]), allowLocalUrls: false,
    contract: (id) => (id === "c_1" ? cur : undefined),
    saveContract: (_id, body) => { const v = validateContract(body); if (!v.ok) return { errors: v.errors }; saved.push(body); cur.body = v.contract; cur.version++; return { version: cur.version }; },
  });
  return { p, cur, saved, events };
}

test("a proposal is stored and never applied", () => {
  const { p, cur, saved, events } = store();
  const o = p.propose({ contract_id: "c_1", changes: { tasks: ["echo", "ask"], prompts: ["summarise"] }, note: "need ask" }, "t_1");
  assert.ok("out" in o);
  if (!("out" in o)) return;
  assert.equal(o.out.state, "pending");
  assert.equal(o.out.widening, false);
  assert.equal(o.out.note, "need ask");
  assert.deepEqual(saved, []);
  assert.equal(cur.version, 1);
  assert.deepEqual(events.map((e) => e[0]), ["proposal.created"]);
});

test("a widening proposal is flagged", () => {
  const { p } = store();
  const o = p.propose({ contract_id: "c_1", changes: { tasks: ["echo", "claude"] } }, null);
  assert.ok("out" in o && o.out.widening === true && o.out.changes.some((c) => c.widening));
});

test("bad proposals: unknown contract, unknown field, invalid value, no change, long note", () => {
  const { p } = store();
  assert.ok("notFound" in p.propose({ contract_id: "c_9", changes: { dailyLimit: 5 } }, null));
  assert.ok("errors" in p.propose({ contract_id: "c_1", changes: { id: "x" } }, null));
  assert.ok("errors" in p.propose({ contract_id: "c_1", changes: {} }, null));
  const bad = p.propose({ contract_id: "c_1", changes: { folders: ["~/"] } }, null);
  assert.ok("errors" in bad && bad.errors.folders);
  assert.ok("errors" in p.propose({ contract_id: "c_1", changes: { dailyLimit: 10 } }, null));
  assert.ok("errors" in p.propose({ contract_id: "c_1", changes: { dailyLimit: 5 }, note: "x".repeat(501) }, null));
  assert.equal(p.list().length, 0);
});

test("apply changes the contract once and appends an event; a second apply conflicts", () => {
  const { p, cur, events } = store();
  const o = p.propose({ contract_id: "c_1", changes: { dailyLimit: 3 } }, null);
  if (!("out" in o)) throw new Error("no");
  const a = p.apply(o.out.id);
  assert.ok("out" in a && a.out.state === "applied");
  assert.equal(cur.body.dailyLimit, 3);
  assert.equal(cur.version, 2);
  assert.ok("conflict" in p.apply(o.out.id));
  assert.ok("conflict" in p.decline(o.out.id));
  assert.deepEqual(events.map((e) => e[0]), ["proposal.created", "proposal.applied"]);
});

test("decline leaves the contract alone", () => {
  const { p, cur, saved } = store();
  const o = p.propose({ contract_id: "c_1", changes: { dailyLimit: 3 } }, null);
  if (!("out" in o)) throw new Error("no");
  const x = p.decline(o.out.id, "not now");
  assert.ok("out" in x && x.out.state === "declined" && x.out.reason === "not now");
  assert.equal(cur.version, 1);
  assert.deepEqual(saved, []);
  assert.ok("conflict" in p.apply(o.out.id));
});

test("a proposal goes stale when the contract changed after it was written", () => {
  const { p, cur } = store();
  const o = p.propose({ contract_id: "c_1", changes: { dailyLimit: 3 } }, null);
  if (!("out" in o)) throw new Error("no");
  cur.version = 2;
  assert.ok("conflict" in p.apply(o.out.id));
  assert.equal(p.get(o.out.id)!.state, "stale");
  assert.equal(cur.body.dailyLimit, 10);
});

test("pending proposals are capped", () => {
  const { p } = store();
  for (let i = 0; i < MAX_PENDING_PROPOSALS; i++) assert.ok("out" in p.propose({ contract_id: "c_1", changes: { name: `N${i}` } }, null));
  assert.ok("conflict" in p.propose({ contract_id: "c_1", changes: { name: "over" } }, null));
  assert.equal(p.pending().length, MAX_PENDING_PROPOSALS);
});
