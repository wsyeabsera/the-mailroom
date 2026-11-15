import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseHubUrl, computeBadge, detectNewParcels, needsYouModel, eventsModel, laptopChip, countsModel, approvalsUrl, relativeTime } from "../extension/lib.js";

test("parseHubUrl accepts bare origins", () => {
  assert.deepEqual(parseHubUrl("https://mailroom.example.com/"), { ok: true, origin: "https://mailroom.example.com", pattern: "https://mailroom.example.com/*" });
  const l = parseHubUrl("http://localhost:8787");
  assert.equal(l.ok, true);
  assert.equal(l.origin, "http://localhost:8787");
  assert.equal(l.pattern, "http://localhost/*");
});
test("parseHubUrl rejects bad input", () => {
  for (const bad of ["", "nope", "ftp://x.com", "http://example.com", "https://x.com/app", "https://x.com/?a=1", "https://u:p@x.com", "javascript:alert(1)"]) {
    assert.equal(parseHubUrl(bad).ok, false, bad);
  }
});
const st = (o = {}) => ({ kind: "ok", state: { daemon: { connected: true, last_seen: 1 }, counts: {}, needs_you: [], latest_events: [], approvals: 0, ...o } });
test("badge computation", () => {
  assert.equal(computeBadge(st()).text, "");
  const b = computeBadge(st({ approvals: 3 }));
  assert.equal(b.text, "3"); assert.equal(b.color, "#f2703a");
  assert.equal(computeBadge(st({ approvals: 250 })).text, "99+");
  const away = computeBadge(st({ daemon: { connected: false, last_seen: null }, approvals: 2 }));
  assert.equal(away.text, "2"); assert.equal(away.color, "#e0a030"); assert.match(away.title, /2 waiting.*out to lunch/);
  const awayIdle = computeBadge(st({ daemon: { connected: false, last_seen: null }, approvals: 0 }));
  assert.equal(awayIdle.text, "!"); assert.equal(awayIdle.color, "#e0a030");
  assert.equal(computeBadge({ kind: "signed_out" }).text, "x");
  assert.equal(computeBadge({ kind: "unconfigured" }).text, "");
  assert.equal(computeBadge(st({ approvals: undefined, needs_you: [{ id: "a" }, { id: "b" }] })).text, "2");
});
test("new parcel detection", () => {
  const list = [{ id: "p_1" }, { id: "p_2" }];
  assert.deepEqual(detectNewParcels(list, undefined, true), { notify: [], seen: ["p_1", "p_2"] });
  assert.deepEqual(detectNewParcels(list, ["p_1"], false), { notify: ["p_2"], seen: ["p_1", "p_2"] });
  assert.deepEqual(detectNewParcels([], ["p_1"], false), { notify: [], seen: [] });
  assert.deepEqual(detectNewParcels(list, ["p_1", "p_2"], false).notify, []);
});
test("view models", () => {
  assert.deepEqual(needsYouModel([{ id: "p_1", task: "write_file", key: { label: "CI" } }]), [{ id: "p_1", task: "write_file", keyLabel: "CI" }]);
  assert.equal(needsYouModel([{ id: "p_2", task: "echo", key_label: "x" }])[0].keyLabel, "x");
  const now = 1_000_000_000;
  const ev = eventsModel([{ seq: 2, ts: now - 120000, kind: "job.waiting_approval", payload: { job_id: "p_4821" } }, { seq: 1, ts: now, kind: "daemon.connected", payload: {} }], 5, now);
  assert.equal(ev[0].text, "p_4821 waiting for approval"); assert.equal(ev[0].time, "2 min ago");
  assert.equal(ev[1].text, "Laptop connected");
  assert.equal(eventsModel(Array.from({ length: 9 }, (_, i) => ({ seq: i, ts: now, kind: "job.done", payload: {} })), 5, now).length, 5);
  assert.equal(laptopChip({ connected: true }).label, "Laptop connected");
  assert.equal(laptopChip({ connected: false, last_seen: 0 + 1000 }, 61000).detail, "last seen 1 min ago");
  assert.equal(laptopChip(null).detail, "last seen never");
  assert.equal(countsModel({ waiting_approval: 2 })[0].value, 2);
  assert.equal(countsModel({}).length, 5);
  assert.equal(approvalsUrl("https://h", "p_1"), "https://h/#/approvals/p_1");
  assert.equal(approvalsUrl("https://h"), "https://h/#/approvals");
  assert.equal(relativeTime(NaN), "never");
});
test("manifest parses, references exist, permissions minimal", () => {
  const dir = join(import.meta.dirname, "..", "extension");
  const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  assert.equal(m.manifest_version, 3);
  assert.deepEqual([...m.permissions].sort(), ["alarms", "notifications", "sidePanel", "storage"]);
  assert.ok(!JSON.stringify(m.permissions).includes("all_urls"));
  assert.ok(!m.host_permissions);
  const files = [m.background.service_worker, m.action.default_popup, m.options_ui.page, m.side_panel.default_path, ...Object.values(m.icons), ...Object.values(m.action.default_icon)];
  for (const f of files) assert.ok(existsSync(join(dir, f)), f);
  for (const html of ["popup.html", "sidepanel.html", "options.html"]) {
    const t = readFileSync(join(dir, html), "utf8");
    for (const r of t.matchAll(/(?:src|href)="([^"#]+)"/g)) assert.ok(existsSync(join(dir, r[1])), `${html} -> ${r[1]}`);
    assert.ok(!/(?:src|href)="https?:/.test(t), "no remote refs in " + html);
  }
  assert.equal(m.action.default_popup && !m.side_panel.openPanelOnActionClick, true);
});
