import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { CRED, cli, tmpHome, FakeHub } from "./daemon-helpers.ts";

test("login writes config 0600 in a 0700 dir, never echoes the credential", async () => {
  const home = tmpHome();
  const p = cli(home, ["login", "--url", "http://localhost:8787", "--credential", CRED]);
  assert.equal(await p.exited, 0);
  assert.ok(!p.out().includes(CRED));
  const f = path.join(home, ".mailroom/config.json");
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(f)).mode & 0o777, 0o700);
  assert.deepEqual(JSON.parse(fs.readFileSync(f, "utf8")), { url: "http://localhost:8787", credential: CRED });
});

test("login works from env and refuses a non mrd_ credential", async () => {
  const home = tmpHome();
  const bad = cli(home, ["login"], { MAILROOM_URL: "http://x.test", MAILROOM_CREDENTIAL: "mr_live_nope" });
  assert.notEqual(await bad.exited, 0);
  assert.ok(!fs.existsSync(path.join(home, ".mailroom/config.json")));
  const ok = cli(home, ["login"], { MAILROOM_URL: "http://x.test", MAILROOM_CREDENTIAL: CRED });
  assert.equal(await ok.exited, 0);
});

test("status accepts / rejects, logout deletes", async () => {
  const hub = new FakeHub();
  await hub.start();
  const home = tmpHome();
  await cli(home, ["login", "--url", hub.url, "--credential", CRED]).exited;
  const s = cli(home, ["status"]);
  assert.equal(await s.exited, 0);
  assert.match(s.out(), /hub: accepted/);
  assert.ok(!s.out().includes(CRED));
  // Regression: `status` used to open a second daemon socket, which made the Hub drop the running daemon.
  assert.equal(hub.sockets.length, 0, "status must not connect as a daemon");
  assert.equal(hub.probes, 1);
  await cli(home, ["login", "--url", hub.url, "--credential", "mrd_" + "b".repeat(32)]).exited;
  const s2 = cli(home, ["status"]);
  assert.notEqual(await s2.exited, 0);
  assert.match(s2.out(), /rejected/);
  assert.equal(await cli(home, ["logout"]).exited, 0);
  assert.ok(!fs.existsSync(path.join(home, ".mailroom/config.json")));
  await hub.stop();
});
