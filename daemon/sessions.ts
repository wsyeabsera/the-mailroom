// Claude session ids per job, so a later ask/claude job can continue an earlier one (`claude --resume <session id>`).
// ~/.mailroom/sessions.json (mode 0600): { "<job id>": { sessionId, task, prompt?, cwd, at } }. Entries older than 7 days are dropped.
// The daemon does not know which key sent a job; the Hub checks that the earlier job belongs to the same key before it queues a resume.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { JOB_ID_RE } from "../shared/contract.ts";

export const SESSION_TTL_MS = 7 * 24 * 3600_000;
const SESSION_ID_RE = /^[\w-]{1,100}$/;
const MAX_ENTRIES = 2000;

export type SessionEntry = { sessionId: string; task: string; prompt?: string; cwd: string; at: number };
export type Sessions = Record<string, SessionEntry>;

export const sessionsPath = (home = os.homedir()) => path.join(home, ".mailroom", "sessions.json");
export const scratchRoot = (home = os.homedir()) => path.join(home, ".mailroom", "scratch");

/** Keeps the well-formed entries newer than the TTL, newest MAX_ENTRIES at most. Pure. */
export function prune(raw: unknown, now: number): Sessions {
  const out: Sessions = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const rows: [string, SessionEntry][] = [];
  for (const [id, e] of Object.entries(raw as Record<string, any>)) {
    if (!JOB_ID_RE.test(id) || !e || typeof e !== "object") continue;
    if (typeof e.sessionId !== "string" || !SESSION_ID_RE.test(e.sessionId) || typeof e.task !== "string" || typeof e.cwd !== "string" || typeof e.at !== "number") continue;
    if (now - e.at > SESSION_TTL_MS || e.at > now + 3600_000) continue;
    rows.push([id, { sessionId: e.sessionId, task: e.task, ...(typeof e.prompt === "string" ? { prompt: e.prompt } : {}), cwd: e.cwd, at: e.at }]);
  }
  rows.sort((a, b) => b[1].at - a[1].at);
  for (const [id, e] of rows.slice(0, MAX_ENTRIES)) Object.defineProperty(out, id, { value: e, enumerable: true, writable: true, configurable: true });
  return out;
}

/** Reads the file; a missing or broken file is an empty store (a resume then fails as "unknown"). */
export function loadSessions(home = os.homedir(), now = Date.now()): Sessions {
  try {
    return prune(JSON.parse(fs.readFileSync(sessionsPath(home), "utf8")), now);
  } catch {
    return {};
  }
}

/** Stores a finished job's session id (and prunes old ones). Never throws: losing a session id only costs the resume. */
export function recordSession(jobId: string, entry: Omit<SessionEntry, "at">, home = os.homedir(), now = Date.now()): void {
  try {
    if (!JOB_ID_RE.test(jobId) || !SESSION_ID_RE.test(entry.sessionId)) return;
    const all = loadSessions(home, now);
    Object.defineProperty(all, jobId, { value: { ...entry, at: now }, enumerable: true, writable: true, configurable: true });
    const file = sessionsPath(home);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(all, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {
    /* ignore */
  }
}

/** May a job of this task (and prompt, for ask) continue job `resume`? Unknown, expired, another task or another prompt: no. */
export function findResume(resume: unknown, task: string, prompt: string | undefined, home = os.homedir(), now = Date.now()): { session: SessionEntry } | { error: string } {
  if (typeof resume !== "string" || !JOB_ID_RE.test(resume)) return { error: "resume must be the id of an earlier job" };
  const all = loadSessions(home, now);
  const e = Object.hasOwn(all, resume) ? all[resume] : null;
  if (!e) return { error: `cannot resume ${resume}: the laptop has no session for that job (unknown, expired after 7 days, or it never finished)` };
  if (e.task !== task) return { error: `cannot resume ${resume}: it was a ${e.task} job, not ${task}` };
  if (task === "ask" && e.prompt !== prompt) return { error: `cannot resume ${resume}: it ran the prompt “${e.prompt}”, not “${prompt}”` };
  return { session: e };
}
