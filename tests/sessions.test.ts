import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { SESSION_TTL_MS, findResume, loadSessions, prune, recordSession, sessionsPath } from "../daemon/sessions.ts";
import { resumeRefusal } from "../src/job-rules.ts";
import { tmpHome } from "./daemon-helpers.ts";

const NOW = Date.parse("2026-11-18T12:00:00Z");

test("prune: drops entries older than 7 days, malformed ones and bad ids", () => {
  const good = { sessionId: "s-1", task: "ask", prompt: "p", cwd: "/x", at: NOW - 1000 };
  const out = prune({ p_1: good, p_old: { ...good, at: NOW - SESSION_TTL_MS - 1 }, p_edge: { ...good, at: NOW - SESSION_TTL_MS }, "../x": good, p_bad: { ...good, sessionId: "a b; rm" }, p_no: { sessionId: "s" }, p_str: "x", p_future: { ...good, at: NOW + 7 * 24 * 3600_000 } }, NOW);
  assert.deepEqual(Object.keys(out).sort(), ["p_1", "p_edge"]);
  assert.deepEqual(prune(null, NOW), {});
  assert.deepEqual(prune([1], NOW), {});
});

test("recordSession writes a 0600 file, keeps others, prunes old entries", () => {
  const home = tmpHome();
  recordSession("p_1", { sessionId: "s-1", task: "ask", prompt: "find", cwd: "/a" }, home, NOW - SESSION_TTL_MS - 5000);
  recordSession("p_2", { sessionId: "s-2", task: "claude", cwd: "/b" }, home, NOW);
  assert.equal(fs.statSync(sessionsPath(home)).mode & 0o777, 0o600);
  assert.deepEqual(Object.keys(loadSessions(home, NOW)), ["p_2"]);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(sessionsPath(home), "utf8"))), ["p_2"], "the old entry is gone from the file too");
  assert.deepEqual(fs.readdirSync(path.dirname(sessionsPath(home))).filter(f => f.endsWith(".tmp")), []);
  recordSession("../evil", { sessionId: "s", task: "ask", cwd: "/a" }, home, NOW);
  recordSession("p_3", { sessionId: "bad id", task: "ask", cwd: "/a" }, home, NOW);
  assert.deepEqual(Object.keys(loadSessions(home, NOW)), ["p_2"]);
});

test("loadSessions: a missing or corrupt file is an empty store", () => {
  const home = tmpHome();
  assert.deepEqual(loadSessions(home, NOW), {});
  fs.mkdirSync(path.join(home, ".mailroom"));
  fs.writeFileSync(sessionsPath(home), "{nope");
  assert.deepEqual(loadSessions(home, NOW), {});
});

test("findResume: unknown, expired, other task, other prompt are errors; a match returns the session", () => {
  const home = tmpHome();
  recordSession("p_old", { sessionId: "s-o", task: "ask", prompt: "find", cwd: "/a" }, home, NOW - SESSION_TTL_MS - 1000);
  recordSession("p_a", { sessionId: "s-a", task: "ask", prompt: "find", cwd: "/a" }, home, NOW);
  recordSession("p_c", { sessionId: "s-c", task: "claude", cwd: "/c" }, home, NOW);
  assert.equal((findResume("p_a", "ask", "find", home, NOW) as any).session.sessionId, "s-a");
  assert.equal((findResume("p_c", "claude", undefined, home, NOW) as any).session.sessionId, "s-c");
  assert.match((findResume("p_nope", "ask", "find", home, NOW) as any).error, /no session/);
  assert.match((findResume("p_old", "ask", "find", home, NOW) as any).error, /no session/);
  assert.match((findResume("p_a", "claude", undefined, home, NOW) as any).error, /was a ask job, not claude/);
  assert.match((findResume("p_c", "ask", "find", home, NOW) as any).error, /not ask/);
  assert.match((findResume("p_a", "ask", "other", home, NOW) as any).error, /prompt “find”, not “other”/);
  assert.match((findResume("toString", "ask", "find", home, NOW) as any).error, /no session/);
  assert.match((findResume("../x", "ask", "find", home, NOW) as any).error, /id of an earlier job/);
  assert.match((findResume(5, "ask", "find", home, NOW) as any).error, /id of an earlier job/);
});

test("resumeRefusal (Hub): only this key's own ask or claude job; one message for missing and foreign", () => {
  assert.equal(resumeRefusal({ key_id: "k1", task: "ask" }, "k1"), null);
  assert.equal(resumeRefusal({ key_id: "k1", task: "claude" }, "k1"), null);
  const msg = resumeRefusal(undefined, "k1");
  assert.match(msg!, /earlier ask or claude job of this key/);
  assert.equal(resumeRefusal({ key_id: "k2", task: "ask" }, "k1"), msg, "another key's job looks the same as a missing one");
  assert.equal(resumeRefusal({ key_id: "k1", task: "run" }, "k1"), msg);
  assert.equal(resumeRefusal(null, "k1"), msg);
});
