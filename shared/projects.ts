// Pure project rules, shared by the Hub and tests: validating a project, sanitising the laptop's (untrusted) command report,
// and the Commands tab view. No I/O, no clock, no globals.
import { normalizePath } from "./contract.ts";

import type { ArgSpec } from "./args.ts";
export type { ArgSpec };
export type ReportedCommand = { name: string; project: string | null; args: Record<string, ArgSpec>; timeoutMs: number | null };
export type ProjectInput = { name: string; folder: string | null; notes: string; color: string | null };

const NAME_RE = /^[\w.-]{1,60}$/;
export const MAX_REPORT_COMMANDS = 200;
const MAX_ARGS = 20;
const MAX_ENUM_VALUES = 50;
const MAX_ENUM_LEN = 100;
const ARG_TYPES = ["string", "number", "boolean", "enum"];

export function validateProject(raw: unknown): { ok: true; project: ProjectInput } | { ok: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const o = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;

  const name = typeof o.name === "string" ? o.name.trim() : "";
  if (name.length < 1 || name.length > 60) errors.name = "Give it a name of 1 to 60 characters.";

  let folder: string | null = null;
  if (o.folder !== undefined && o.folder !== null && o.folder !== "") {
    const n = typeof o.folder === "string" ? normalizePath(o.folder.trim()) : null;
    if (n === null) errors.folder = "Use a folder starting with ~/ or /.";
    else folder = n;
  }

  let notes = "";
  if (o.notes !== undefined && o.notes !== null) {
    if (typeof o.notes !== "string" || o.notes.length > 2000) errors.notes = "Notes can be at most 2000 characters.";
    else notes = o.notes;
  }

  let color: string | null = null;
  if (o.color !== undefined && o.color !== null && o.color !== "") {
    if (typeof o.color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(o.color)) errors.color = "Use a colour like #1a2b3c.";
    else color = o.color;
  }

  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, project: { name, folder, notes, color } };
}

function sanitizeArg(s: unknown): ArgSpec | null {
  if (!s || typeof s !== "object" || Array.isArray(s)) return null;
  const o = s as Record<string, unknown>;
  if (typeof o.type !== "string" || !ARG_TYPES.includes(o.type)) return null;
  const spec: ArgSpec = { type: o.type as ArgSpec["type"] };
  if (o.required === true) spec.required = true;
  if (typeof o.maxLength === "number" && Number.isFinite(o.maxLength) && o.maxLength > 0) spec.maxLength = Math.floor(o.maxLength);
  if (spec.type === "enum") {
    const vals = Array.isArray(o.values) ? o.values.filter((v): v is string => typeof v === "string" && v.length <= MAX_ENUM_LEN) : [];
    spec.values = vals.slice(0, MAX_ENUM_VALUES);
  }
  return spec;
}

/** The laptop's report is untrusted display data: anything off-limits is dropped, never an error. */
export function sanitizeReport(raw: unknown): ReportedCommand[] {
  if (!Array.isArray(raw)) return [];
  const out: ReportedCommand[] = [];
  const seen = new Set<string>();
  for (const c of raw) {
    if (out.length >= MAX_REPORT_COMMANDS) break;
    if (!c || typeof c !== "object" || Array.isArray(c)) continue;
    const o = c as Record<string, unknown>;
    if (typeof o.name !== "string" || !NAME_RE.test(o.name) || seen.has(o.name)) continue;
    seen.add(o.name);
    const args: Record<string, ArgSpec> = {};
    if (o.args && typeof o.args === "object" && !Array.isArray(o.args)) {
      let n = 0;
      for (const [k, v] of Object.entries(o.args)) {
        if (n >= MAX_ARGS) break;
        if (!NAME_RE.test(k)) continue;
        const spec = sanitizeArg(v);
        if (!spec) continue;
        Object.defineProperty(args, k, { value: spec, enumerable: true, writable: true, configurable: true });
        n++;
      }
    }
    const project = typeof o.project === "string" && o.project.length > 0 && o.project.length <= 60 ? o.project : null;
    const timeoutMs = typeof o.timeoutMs === "number" && Number.isFinite(o.timeoutMs) && o.timeoutMs > 0 ? Math.floor(o.timeoutMs) : null;
    out.push({ name: o.name, project, args, timeoutMs });
  }
  return out;
}

export type CommandRow = {
  name: string;
  onLaptop: boolean;
  taggedTo: string | null;
  viaKeys: string[];
  mismatch: "other-project" | "unknown-project" | "not-on-laptop" | null;
};

/** The Commands tab: commands tagged to this project plus commands its keys' contracts allow, each with a mismatch badge if the pieces disagree. */
export function commandsView(args: {
  projectId: string;
  projects: { id: string; archived: boolean }[];
  reported: ReportedCommand[] | null;
  keyContracts: { keyId: string; commands: string[] }[];
}): { rows: CommandRow[]; reported: boolean } {
  const { projectId, projects, reported, keyContracts } = args;
  const onLaptop = new Map<string, ReportedCommand>();
  for (const c of reported ?? []) onLaptop.set(c.name, c);
  const via = new Map<string, string[]>();
  for (const k of keyContracts)
    for (const name of k.commands) {
      const list = via.get(name) ?? [];
      if (!list.includes(k.keyId)) list.push(k.keyId);
      via.set(name, list);
    }
  const names = new Set<string>(via.keys());
  for (const c of onLaptop.values()) if (c.project === projectId) names.add(c.name);

  const live = new Set(projects.filter((p) => !p.archived).map((p) => p.id));
  const rows: CommandRow[] = [...names].sort().map((name) => {
    const rep = onLaptop.get(name);
    const taggedTo = rep?.project ?? null;
    const viaKeys = via.get(name) ?? [];
    let mismatch: CommandRow["mismatch"] = null;
    if (taggedTo !== null && !live.has(taggedTo)) mismatch = "unknown-project";
    else if (taggedTo !== null && taggedTo !== projectId) mismatch = "other-project";
    else if (reported && viaKeys.length > 0 && !rep) mismatch = "not-on-laptop";
    return { name, onLaptop: !!rep, taggedTo, viaKeys, mismatch };
  });
  return { rows, reported: reported !== null };
}
