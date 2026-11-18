import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { CRED, FakeHub, cli, tmpHome } from "./daemon-helpers.ts";

let hub: FakeHub, d: ReturnType<typeof cli>;

before(async () => {
  hub = new FakeHub();
  await hub.start();
  const home = tmpHome();
  await cli(home, ["login", "--url", hub.url, "--credential", CRED]).exited;
  d = cli(home, ["run"]);
  await hub.waitFor(m => m.type === "hello");
});
after(async () => {
  d.kill();
  await hub.stop();
});

test("the daemon answers a ping with the same id (the Hub's connection test relies on it)", async () => {
  hub.push({ type: "ping", id: "t-123" });
  const m = await hub.waitFor(x => x.type === "pong" && x.id === "t-123");
  assert.equal(m.type, "pong");
});
