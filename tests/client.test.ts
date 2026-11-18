import test from "node:test";
import assert from "node:assert/strict";
import { createClient, MailroomError } from "../client/mailroom-client.mjs";

function fake(handler: (req: { method: string; path: string; headers: any; body: any }) => [number, any]) {
  const calls: any[] = [];
  const f = async (url: string, init: any) => {
    const req = { method: init.method, path: new URL(url).pathname, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(req);
    const [status, body] = handler(req);
    return new Response(JSON.stringify(body), { status });
  };
  return { calls, mr: createClient({ url: "https://hub.test/", key: "mr_live_x", fetch: f as any }) };
}

test("submit posts task and args with the bearer key and idempotency header", async () => {
  const { mr, calls } = fake(() => [202, { id: "p_1", state: "queued" }]);
  assert.deepEqual(await mr.submit("echo", { text: "hi" }, { idempotency: "abc" }), { id: "p_1", state: "queued" });
  assert.equal(calls[0].path, "/api/jobs");
  assert.equal(calls[0].headers.authorization, "Bearer mr_live_x");
  assert.equal(calls[0].headers["idempotency-key"], "abc");
  assert.deepEqual(calls[0].body, { task: "echo", args: { text: "hi" } });
});

test("submit sends an optional label in the body, and leaves it out otherwise", async () => {
  const { mr, calls } = fake(() => [202, { id: "p_1", state: "queued" }]);
  await mr.submit("echo", { text: "hi" }, { label: "test" });
  assert.deepEqual(calls[0].body, { task: "echo", args: { text: "hi" }, label: "test" });
  await mr.submit("echo", { text: "hi" });
  assert.equal("label" in calls[1].body, false);
});

test("a refused parcel resolves as refused; other errors throw MailroomError", async () => {
  let r = fake(() => [403, { id: "p_2", state: "refused", reason: "no" }]);
  assert.equal((await r.mr.submit("x")).state, "refused");
  r = fake(() => [401, { error: "bad_key" }]);
  await assert.rejects(r.mr.submit("x"), (e: any) => e instanceof MailroomError && e.status === 401 && e.code === "bad_key");
});

test("wait polls, reports each new progress once, and returns the finished job", async () => {
  const seq: any[] = [
    { state: "running", progress: { text: "a", pct: 10 } },
    { state: "running", progress: { text: "a", pct: 10 } },
    { state: "running", progress: { text: "b", pct: 60 } },
    { state: "done", result: { ok: 1 } },
  ];
  let i = 0;
  const { mr } = fake(() => [200, { id: "p_1", ...seq[i++] }]);
  const seen: any[] = [];
  const job = await mr.wait("p_1", { intervalMs: 1, onProgress: (p: any) => seen.push(p) });
  assert.equal(job.state, "done");
  assert.deepEqual(seen.map(p => p.text), ["a", "b"]);
});

test("wait times out and leaves the parcel alone", async () => {
  const { mr } = fake(() => [200, { id: "p_1", state: "running" }]);
  await assert.rejects(mr.wait("p_1", { intervalMs: 5, timeoutMs: 20 }), (e: any) => e.code === "timeout");
});

test("cancel posts to /api/jobs/:id/cancel", async () => {
  const { mr, calls } = fake(() => [200, { id: "p_1", state: "cancelled" }]);
  assert.equal((await mr.cancel("p_1")).state, "cancelled");
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].path, "/api/jobs/p_1/cancel");
});

test("run submits a run job and returns the result, or throws on failure", async () => {
  let { mr, calls } = fake(r => r.method === "POST" ? [202, { id: "p_3", state: "queued" }] : [200, { id: "p_3", state: "done", result: { n: 2 } }]);
  assert.deepEqual(await mr.run("tvdash-scan", { a: 1 }, { intervalMs: 1 }), { n: 2 });
  assert.deepEqual(calls[0].body, { task: "run", args: { command: "tvdash-scan", args: { a: 1 } } });
  ({ mr } = fake(r => r.method === "POST" ? [202, { id: "p_4", state: "queued" }] : [200, { id: "p_4", state: "failed", reason: "boom" }]));
  await assert.rejects(mr.run("c", {}, { intervalMs: 1 }), /boom/);
});
