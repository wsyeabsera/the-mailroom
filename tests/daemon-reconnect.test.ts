import { test } from "node:test";
import assert from "node:assert/strict";
import { CRED, FakeHub, cli, contract, isResult, job, tmpHome } from "./daemon-helpers.ts";

test("reconnects after the hub drops the socket", async () => {
  const hub = new FakeHub();
  await hub.start();
  const home = tmpHome();
  await cli(home, ["login", "--url", hub.url, "--credential", CRED]).exited;
  const d = cli(home, ["run"]);
  await hub.waitFor(m => m.type === "hello");
  hub.ws.terminate();
  for (let i = 0; i < 100 && hub.sockets.length < 2; i++) await new Promise(r => setTimeout(r, 100));
  assert.equal(hub.sockets.length, 2);
  hub.push(job("r1", "echo", { text: "again" }, contract(home)));
  assert.equal((await hub.waitFor(isResult("r1"))).result.echo, "again");
  d.kill();
  await hub.stop();
});

for (const [code, exit] of [[4001, 1], [4002, 2]] as const) {
  test(`exits and does not retry on close ${code}`, async () => {
    const hub = new FakeHub();
    await hub.start();
    const home = tmpHome();
    await cli(home, ["login", "--url", hub.url, "--credential", CRED]).exited;
    const d = cli(home, ["run"]);
    await hub.waitFor(m => m.type === "hello");
    hub.ws.close(code, "x");
    assert.equal(await d.exited, exit);
    if (code === 4001) assert.match(d.out(), /rotated/);
    assert.equal(hub.sockets.length, 1);
    await hub.stop();
  });
}

test("a 401 on upgrade exits non-zero", async () => {
  const hub = new FakeHub();
  await hub.start();
  const home = tmpHome();
  await cli(home, ["login", "--url", hub.url, "--credential", "mrd_" + "z".repeat(32)]).exited;
  assert.equal(await cli(home, ["run"]).exited, 1);
  await hub.stop();
});
