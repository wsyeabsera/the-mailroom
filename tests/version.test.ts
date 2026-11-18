import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { cleanCommit, cleanVersion, daemonNotice, isOlder, VERSION } from "../shared/version.ts";
import { CRED, FakeHub, cli, tmpHome } from "./daemon-helpers.ts";

test("isOlder compares x.y.z numerically", () => {
  assert.equal(isOlder("0.2.0", "0.4.0"), true);
  assert.equal(isOlder("0.4.0", "0.4.0"), false);
  assert.equal(isOlder("0.10.0", "0.9.0"), false);
  assert.equal(isOlder("1.0.0", "0.99.99"), false);
  assert.equal(isOlder("garbage", "0.4.0"), false);
});

test("a hello's version and commit are cleaned", () => {
  assert.equal(cleanVersion("0.4.0"), "0.4.0");
  assert.equal(cleanVersion("<script>"), null);
  assert.equal(cleanVersion(4), null);
  assert.equal(cleanCommit("abc1234"), "abc1234");
  assert.equal(cleanCommit("ABC; rm -rf"), null);
});

test("the notice: old daemon warns, equal or newer does not, none connected does not, a daemon with no version is old", () => {
  assert.match(daemonNotice("0.2.0", "0.4.0", true)!, /runs 0\.2\.0, older than the Hub \(0\.4\.0\).*mailroom service restart/);
  assert.equal(daemonNotice("0.4.0", "0.4.0", true), null);
  assert.equal(daemonNotice("0.5.0", "0.4.0", true), null);
  assert.equal(daemonNotice("0.2.0", "0.4.0", false), null);
  assert.match(daemonNotice(null, "0.4.0", true)!, /did not report a version/);
});

let hub: FakeHub, d: ReturnType<typeof cli>;
before(async () => {
  hub = new FakeHub();
  await hub.start();
  const home = tmpHome();
  await cli(home, ["login", "--url", hub.url, "--credential", CRED]).exited;
  d = cli(home, ["run"]);
});
after(async () => { d.kill(); await hub.stop(); });

test("the daemon says its version and git commit in hello", async () => {
  const h = await hub.waitFor(m => m.type === "hello");
  assert.equal(h.version, VERSION);
  assert.match(h.commit, /^[0-9a-f]{12}$/);
});

test("`mailroom service restart` without a service says so", async () => {
  const p = cli(tmpHome(), ["service", "restart"], { MAILROOM_SERVICE_LABEL: "dev.mailroom.test-restart-none" });
  assert.equal(await p.exited, 1);
  assert.match(p.out(), /No service is installed/);
});
