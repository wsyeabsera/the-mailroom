// Contract change proposals in the Hub: a token with the `propose` scope may ask for a change; nothing is applied until the owner says so.
// Storage and rules only: hub.ts wires the owner routes and the MCP tools to these methods and supplies the contract save.
import { validateContract, type Contract } from "../shared/contract.ts";
import { diffContracts, isWidening, PROPOSABLE_FIELDS, type Change } from "../shared/proposal.ts";
import { makeId } from "./keys.ts";
import type { Sql } from "./login-limit.ts";

type Row = Record<string, any>;
export const MAX_PENDING_PROPOSALS = 50;
export const MAX_NOTE = 500;

export const PROPOSAL_TABLE =
  "CREATE TABLE IF NOT EXISTS contract_proposals (id TEXT PRIMARY KEY, contract_id TEXT NOT NULL, base_version INTEGER NOT NULL, body TEXT NOT NULL, changes TEXT NOT NULL, widening INTEGER NOT NULL, note TEXT NOT NULL DEFAULT '', token_id TEXT, state TEXT NOT NULL, reason TEXT, created_at INTEGER NOT NULL, decided_at INTEGER)";

export type ProposalsCtx = {
  sql: Sql;
  next(name: string): number;
  event(kind: string, payload: Record<string, unknown>): unknown;
  contract(id: string): { body: Contract; version: number } | undefined;
  allowLocalUrls: boolean;
  /** Saves the contract the way the owner's editor does (validates, bumps the version, appends contract.saved). */
  saveContract(id: string, body: unknown): { errors: Record<string, string> } | { version: number };
};

export type Outcome<T> = { errors: Record<string, string> } | { conflict: string } | { notFound: string } | { out: T };

export class Proposals {
  private c: ProposalsCtx;
  constructor(c: ProposalsCtx) { this.c = c; }

  private one = (id: string): Row | undefined => this.c.sql.all<Row>("SELECT * FROM contract_proposals WHERE id = ?", id)[0];

  out = (r: Row) => ({
    id: r.id, contract_id: r.contract_id, contract_name: this.c.contract(r.contract_id)?.body.name ?? null, base_version: r.base_version,
    state: r.state as string, widening: !!r.widening, changes: JSON.parse(r.changes) as Change[], note: r.note as string, token_id: r.token_id ?? null,
    ...(r.reason ? { reason: r.reason as string } : {}), created_at: r.created_at as number, decided_at: r.decided_at ?? null,
  });

  list(state?: string | null, limit = 100) {
    const rows = state
      ? this.c.sql.all<Row>("SELECT * FROM contract_proposals WHERE state = ? ORDER BY created_at DESC, id DESC LIMIT ?", state, limit)
      : this.c.sql.all<Row>("SELECT * FROM contract_proposals ORDER BY created_at DESC, id DESC LIMIT ?", limit);
    return rows.map(this.out);
  }
  pending = () => this.c.sql.all<Row>("SELECT * FROM contract_proposals WHERE state = 'pending' ORDER BY created_at, id").map(this.out);
  get(id: string) { const r = this.one(id); return r ? this.out(r) : undefined; }

  /** Stores a proposal: `changes` are fields to set on the contract's current text. Never touches the contract. */
  propose(a: { contract_id: unknown; changes: unknown; note?: unknown }, tokenId: string | null): Outcome<ReturnType<Proposals["out"]>> {
    const cur = typeof a.contract_id === "string" ? this.c.contract(a.contract_id) : undefined;
    if (!cur) return { notFound: `Contract ${String(a.contract_id)}` };
    const ch = a.changes;
    if (!ch || typeof ch !== "object" || Array.isArray(ch) || Object.keys(ch).length === 0) return { errors: { changes: "Send the fields to change, like {\"tasks\": [...]}." } };
    const unknown = Object.keys(ch).filter((k) => !(PROPOSABLE_FIELDS as readonly string[]).includes(k));
    if (unknown.length) return { errors: { changes: `Cannot propose a change to ${unknown.join(", ")}. Fields: ${PROPOSABLE_FIELDS.join(", ")}.` } };
    const note = a.note === undefined || a.note === null ? "" : a.note;
    if (typeof note !== "string" || note.length > MAX_NOTE) return { errors: { note: `A note is text of up to ${MAX_NOTE} characters.` } };
    const v = validateContract({ ...cur.body, ...(ch as object) }, { allowLocal: this.c.allowLocalUrls });
    if (!v.ok) return { errors: v.errors };
    const changes = diffContracts(cur.body, v.contract);
    if (!changes.length) return { errors: { changes: "That changes nothing: the contract already says this." } };
    if (this.c.sql.all<Row>("SELECT COUNT(*) AS n FROM contract_proposals WHERE state = 'pending'")[0].n >= MAX_PENDING_PROPOSALS) return { conflict: `There are already ${MAX_PENDING_PROPOSALS} proposals waiting for the owner. Wait for them to be decided.` };
    const id = makeId("pp_", this.c.next("proposal"));
    const widening = isWidening(changes);
    this.c.sql.run("INSERT INTO contract_proposals (id, contract_id, base_version, body, changes, widening, note, token_id, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)",
      id, a.contract_id, cur.version, JSON.stringify(v.contract), JSON.stringify(changes), widening ? 1 : 0, note.trim(), tokenId, Date.now());
    this.c.event("proposal.created", { proposal_id: id, contract_id: a.contract_id, widening, changes: changes.length, ...(tokenId ? { token_id: tokenId } : {}) });
    return { out: this.out(this.one(id)!) };
  }

  /** Owner applies it: the stored text replaces the contract, but only if the contract is still the version it was written against. */
  apply(id: string): Outcome<ReturnType<Proposals["out"]>> {
    const r = this.one(id);
    if (!r) return { notFound: `Proposal ${id}` };
    if (r.state !== "pending") return { conflict: `proposal is ${r.state}` };
    const cur = this.c.contract(r.contract_id);
    if (!cur) return { conflict: "the contract no longer exists" };
    if (cur.version !== r.base_version) {
      this.decide(r, "stale", "the contract changed after this was proposed");
      return { conflict: "the contract changed after this was proposed; ask for a new proposal" };
    }
    const saved = this.c.saveContract(r.contract_id, JSON.parse(r.body));
    if ("errors" in saved) return { errors: saved.errors };
    this.decide(r, "applied", null);
    this.c.event("proposal.applied", { proposal_id: id, contract_id: r.contract_id, version: saved.version, widening: !!r.widening });
    return { out: this.out(this.one(id)!) };
  }

  decline(id: string, note?: string): Outcome<ReturnType<Proposals["out"]>> {
    const r = this.one(id);
    if (!r) return { notFound: `Proposal ${id}` };
    if (r.state !== "pending") return { conflict: `proposal is ${r.state}` };
    this.decide(r, "declined", note ? note.slice(0, 200) : null);
    this.c.event("proposal.declined", { proposal_id: id, contract_id: r.contract_id });
    return { out: this.out(this.one(id)!) };
  }

  private decide(r: Row, state: string, reason: string | null) {
    this.c.sql.run("UPDATE contract_proposals SET state = ?, reason = ?, decided_at = ? WHERE id = ?", state, reason, Date.now(), r.id);
  }
}
