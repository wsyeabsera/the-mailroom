// Projects in the Hub: storage, admin routes, the laptop's command report. Kept out of hub.ts so that file only wires it in.
// A project grants nothing: contracts (Hub) and the laptop policy stay the only gates. The laptop report is untrusted display data.
import type { Contract } from "../shared/contract.ts";
import { commandsView, sanitizeReport, validateProject, type ReportedCommand } from "../shared/projects.ts";
import { PROMPT_REPORT_TABLE } from "./prompt-report.ts";
import { makeId } from "./keys.ts";
import type { Sql } from "./login-limit.ts";

type Row = Record<string, any>;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const err = (status: number, error: string, extra: Record<string, unknown> = {}) => json({ error, ...extra }, status);
const invalid = (errors: Record<string, string>) => err(422, "invalid", { errors });
const utcMidnight = (now: number) => now - (now % 86_400_000);

export const UNASSIGNED = "unassigned";

export const PROJECT_TABLES = [
  "CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, folder TEXT, notes TEXT NOT NULL DEFAULT '', color TEXT, created_at INTEGER NOT NULL, archived_at INTEGER)",
  "CREATE TABLE IF NOT EXISTS laptop_report (id INTEGER PRIMARY KEY CHECK (id = 1), commands TEXT NOT NULL, reported_at INTEGER NOT NULL)",
  PROMPT_REPORT_TABLE, // sibling of laptop_report (src/prompt-report.ts)
];

/** Tables plus the guarded ALTER: safe on every start (a second run hits "duplicate column" and carries on). */
export function ensureProjectSchema(sql: Sql) {
  for (const q of PROJECT_TABLES) sql.run(q);
  const cols = sql.all<Row>("PRAGMA table_info(keys)");
  if (!cols.some((c) => c.name === "project_id")) {
    try {
      sql.run("ALTER TABLE keys ADD COLUMN project_id TEXT");
    } catch {
      /* already there */
    }
  }
}

/** Replaces the stored report. Whatever the laptop sent is sanitised; it can never throw. */
export function storeReport(sql: Sql, raw: unknown, now = Date.now()) {
  const commands = sanitizeReport(raw);
  sql.run("INSERT INTO laptop_report (id, commands, reported_at) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET commands = excluded.commands, reported_at = excluded.reported_at", JSON.stringify(commands), now);
}

export function loadReport(sql: Sql): { commands: ReportedCommand[]; reported_at: number } | null {
  const r = sql.all<Row>("SELECT commands, reported_at FROM laptop_report WHERE id = 1")[0];
  if (!r) return null;
  try {
    return { commands: sanitizeReport(JSON.parse(r.commands)), reported_at: r.reported_at };
  } catch {
    return null;
  }
}

export type ProjectsCtx = {
  sql: Sql;
  next(name: string): number;
  event(kind: string, payload: Record<string, unknown>): unknown;
  keyOut(k: Row): unknown;
  jobOut(j: Row): unknown;
  progress(jobId: string): { text: string; pct?: number; at: number } | undefined;
  contractBody(id: string): Contract | undefined;
  readJson(req: Request): Promise<{ ok: true; body: any } | { ok: false; res: Response }>;
};

export class Projects {
  constructor(private c: ProjectsCtx) {}

  private row(id: string): Row | undefined {
    return this.c.sql.all<Row>("SELECT * FROM projects WHERE id = ?", id)[0];
  }
  private activeKeys(id: string): number {
    return this.c.sql.all<Row>("SELECT COUNT(*) AS n FROM keys WHERE project_id = ? AND revoked_at IS NULL", id)[0].n;
  }
  private nameTaken(name: string, exceptId: string | null): boolean {
    return this.c.sql.all<Row>("SELECT id, name FROM projects WHERE archived_at IS NULL").some((p) => p.id !== exceptId && String(p.name).toLowerCase() === name.toLowerCase());
  }

  private base(p: Row) {
    return { id: p.id, name: p.name, folder: p.folder ?? null, notes: p.notes ?? "", color: p.color ?? null, archived_at: p.archived_at ?? null, created_at: p.created_at };
  }

  /** Card numbers for one project (or Unassigned) from the jobs of its keys; "today" is UTC. */
  private card(id: string) {
    const sql = this.c.sql;
    const un = id === UNASSIGNED;
    const where = un ? "k.project_id IS NULL" : "k.project_id = ?";
    const p: unknown[] = un ? [] : [id];
    const q = (extra: string, ...more: unknown[]) => sql.all<Row>(`SELECT j.* FROM jobs j JOIN keys k ON k.id = j.key_id WHERE ${where} ${extra}`, ...p, ...more);
    const keyCount = sql.all<Row>(`SELECT COUNT(*) AS n FROM keys k WHERE ${where} AND k.revoked_at IS NULL`, ...p)[0].n as number;
    const run = q("AND j.state = 'running' ORDER BY j.created_at, j.id LIMIT 1")[0];
    const queued = q("AND j.state = 'queued'").length;
    const last = q("AND j.state IN ('done','failed') ORDER BY j.updated_at DESC, j.id DESC LIMIT 1")[0];
    const day = utcMidnight(Date.now());
    const count = (state: string) => q("AND j.state = ? AND j.updated_at >= ?", state, day).length;
    return {
      key_count: keyCount,
      running: run ? { job_id: run.id as string, task: run.task as string, progress: this.c.progress(run.id) ?? null } : null,
      queued,
      last_run: last ? { job_id: last.id as string, state: last.state as string, at: last.updated_at as number } : null,
      today: { done: count("done"), failed: count("failed"), refused: count("refused") },
    };
  }

  list() {
    const rows = this.c.sql.all<Row>("SELECT * FROM projects ORDER BY created_at, id");
    const out: unknown[] = rows.map((p) => ({ ...this.base(p), ...this.card(p.id) }));
    out.push({ id: UNASSIGNED, name: "Unassigned", folder: null, notes: "", color: null, archived_at: null, created_at: null, ...this.card(UNASSIGNED) });
    return out;
  }

  detail(id: string) {
    const un = id === UNASSIGNED;
    const p = un ? undefined : this.row(id);
    if (!un && !p) return undefined;
    const sql = this.c.sql;
    const base = un ? { id: UNASSIGNED, name: "Unassigned", folder: null, notes: "", color: null, archived_at: null, created_at: null } : this.base(p!);
    const where = un ? "project_id IS NULL" : "project_id = ?";
    const args: unknown[] = un ? [] : [id];
    const keys = sql.all<Row>(`SELECT * FROM keys WHERE ${where} ORDER BY created_at DESC, id DESC`, ...args);
    const jobs = sql.all<Row>(`SELECT j.* FROM jobs j JOIN keys k ON k.id = j.key_id WHERE k.${where} ORDER BY j.created_at DESC, j.id DESC LIMIT 20`, ...args);
    const report = loadReport(sql);
    const keyContracts = keys
      .filter((k) => !k.revoked_at)
      .map((k) => ({ keyId: k.id as string, commands: this.c.contractBody(k.contract_id)?.commands ?? [] }));
    const projects = sql.all<Row>("SELECT id, archived_at FROM projects").map((r) => ({ id: r.id as string, archived: !!r.archived_at }));
    return {
      ...base,
      ...this.card(id),
      keys: keys.map((k) => this.c.keyOut(k)),
      recent_jobs: jobs.map((j) => this.c.jobOut(j)),
      commands: commandsView({ projectId: id, projects, reported: report?.commands ?? null, keyContracts }),
      laptop_reported_at: report?.reported_at ?? null,
    };
  }

  /** A project id a key may be moved or issued into: null (Unassigned) or a live project. */
  checkTarget(pid: unknown): { ok: true; id: string | null } | { ok: false; error: string } {
    if (pid === null || pid === undefined || pid === UNASSIGNED) return { ok: true, id: null };
    if (typeof pid !== "string") return { ok: false, error: "Unknown project." };
    const p = this.row(pid);
    if (!p) return { ok: false, error: "Unknown project." };
    if (p.archived_at) return { ok: false, error: "That project is archived. Unarchive it first." };
    return { ok: true, id: pid };
  }

  create(body: unknown): { errors: Record<string, string> } | { out: unknown } {
    const v = validateProject(body);
    if (!v.ok) return { errors: v.errors };
    if (this.nameTaken(v.project.name, null)) return { errors: { name: "A project with that name already exists." } };
    const id = makeId("pr_", this.c.next("project"));
    this.c.sql.run("INSERT INTO projects (id, name, folder, notes, color, created_at) VALUES (?, ?, ?, ?, ?, ?)", id, v.project.name, v.project.folder, v.project.notes, v.project.color, Date.now());
    this.c.event("project.created", { project_id: id, name: v.project.name });
    return { out: { ...this.base(this.row(id)!), ...this.card(id) } };
  }

  update(id: string, body: unknown): { errors: Record<string, string> } | { out: unknown } {
    const p = this.row(id)!;
    const patch = (body && typeof body === "object" && !Array.isArray(body) ? body : {}) as Row;
    const merged = {
      name: "name" in patch ? patch.name : p.name,
      folder: "folder" in patch ? patch.folder : p.folder,
      notes: "notes" in patch ? patch.notes : p.notes,
      color: "color" in patch ? patch.color : p.color,
    };
    const v = validateProject(merged);
    if (!v.ok) return { errors: v.errors };
    if (!p.archived_at && this.nameTaken(v.project.name, id)) return { errors: { name: "A project with that name already exists." } };
    this.c.sql.run("UPDATE projects SET name = ?, folder = ?, notes = ?, color = ? WHERE id = ?", v.project.name, v.project.folder, v.project.notes, v.project.color, id);
    this.c.event("project.updated", { project_id: id, name: v.project.name });
    return { out: { ...this.base(this.row(id)!), ...this.card(id) } };
  }

  async route(req: Request, seg: string[]): Promise<Response> {
    const m = req.method;
    if (seg.length === 2) {
      if (m === "GET") return json(this.list());
      if (m === "POST") {
        const r = await this.c.readJson(req);
        if (!r.ok) return r.res;
        const o = this.create(r.body);
        return "errors" in o ? invalid(o.errors) : json(o.out, 201);
      }
      return err(405, "method_not_allowed");
    }
    const id = seg[2];
    if (seg.length === 3) {
      if (m === "GET") {
        const d = this.detail(id);
        return d ? json(d) : err(404, "not_found");
      }
      if (m === "PATCH") {
        if (!this.row(id)) return err(404, "not_found");
        const r = await this.c.readJson(req);
        if (!r.ok) return r.res;
        const o = this.update(id, r.body);
        return "errors" in o ? invalid(o.errors) : json(o.out);
      }
      return err(405, "method_not_allowed");
    }
    if (seg.length === 4 && (seg[3] === "archive" || seg[3] === "unarchive")) {
      if (m !== "POST") return err(405, "method_not_allowed");
      const p = this.row(id);
      if (!p) return err(404, "not_found");
      if (seg[3] === "archive") {
        if (p.archived_at) return json({ ...this.base(p), ...this.card(id) });
        const n = this.activeKeys(id);
        if (n > 0) return err(409, "has_active_keys", { count: n, message: `This project still has ${n} active key${n === 1 ? "" : "s"}. Move or revoke ${n === 1 ? "it" : "them"} first.` });
        this.c.sql.run("UPDATE projects SET archived_at = ? WHERE id = ?", Date.now(), id);
        this.c.event("project.archived", { project_id: id, name: p.name });
      } else if (p.archived_at) {
        if (this.nameTaken(p.name, id)) return err(409, "name_taken", { message: "Another project already uses this name. Rename one of them first." });
        this.c.sql.run("UPDATE projects SET archived_at = NULL WHERE id = ?", id);
        this.c.event("project.updated", { project_id: id, name: p.name, unarchived: true });
      }
      return json({ ...this.base(this.row(id)!), ...this.card(id) });
    }
    return err(404, "not_found");
  }

  /** PATCH /admin/keys/:id {project_id}: moves a key. */
  async moveKey(req: Request, k: Row): Promise<Response> {
    const r = await this.c.readJson(req);
    if (!r.ok) return r.res;
    if (!("project_id" in r.body)) return invalid({ project_id: "Send project_id (a project id, or null for Unassigned)." });
    const t = this.checkTarget(r.body.project_id);
    if (!t.ok) return invalid({ project_id: t.error });
    if ((k.project_id ?? null) !== t.id) {
      this.c.sql.run("UPDATE keys SET project_id = ? WHERE id = ?", t.id, k.id);
      this.c.event("key.moved", { key_id: k.id, label: k.label, from: k.project_id ?? null, to: t.id });
    }
    return json(this.c.keyOut(this.c.sql.all<Row>("SELECT * FROM keys WHERE id = ?", k.id)[0]));
  }

  /** GET /api/commands: the calling key's contract commands joined with what the laptop reported. Display help only. */
  commandsFor(contractCommands: string[]) {
    const rep = new Map((loadReport(this.c.sql)?.commands ?? []).map((c) => [c.name, c]));
    return contractCommands.map((name) => {
      const c = rep.get(name);
      return { name, on_laptop: !!c, args: c ? c.args : null, timeoutMs: c ? c.timeoutMs : null };
    });
  }
}
