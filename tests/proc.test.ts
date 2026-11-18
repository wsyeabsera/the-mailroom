import test from "node:test";
import assert from "node:assert/strict";
import { spawnTree, killTree, timeoutMessage } from "../daemon/proc.ts";

test("timeoutMessage", () => {
  assert.equal(timeoutMessage(30000), "timed out after 30s");
  assert.equal(timeoutMessage(100), "timed out after 1s");
});

test("killTree kills a child and its grandchild", async () => {
  const child = spawnTree("sh", ["-c", "sleep 30 & echo $!; wait"], { stdio: ["ignore", "pipe", "ignore"] });
  const gc = await new Promise<number>(res => child.stdout!.once("data", d => res(Number(String(d).trim()))));
  const closed = new Promise(res => child.on("close", res));
  killTree(child);
  await closed;
  await new Promise(r => setTimeout(r, 100));
  assert.throws(() => process.kill(gc, 0));
  killTree(child); // a second call is harmless
});
