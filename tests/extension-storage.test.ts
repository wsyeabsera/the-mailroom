import test from "node:test";
import assert from "node:assert/strict";
import { fetchState } from "../extension/storage.js";

test("fetchState gives up on a Hub that never answers", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = ((_u: string, init: { signal: AbortSignal }) =>
    new Promise((_res, rej) => init.signal.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))))) as typeof fetch;
  try {
    const t = Date.now();
    const r = await fetchState("https://hub.example.com", 60);
    assert.equal(r.kind, "error");
    assert.match(r.message ?? "", /No answer from the Hub/);
    assert.ok(Date.now() - t < 1000);
  } finally { globalThis.fetch = real; }
});

test("fetchState still reports signed out, ok and unreachable", async () => {
  const real = globalThis.fetch;
  try {
    globalThis.fetch = (async () => new Response("{}", { status: 401 })) as typeof fetch;
    assert.equal((await fetchState("https://h.example.com")).kind, "signed_out");
    globalThis.fetch = (async () => new Response(JSON.stringify({ approvals: 1 }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
    assert.equal((await fetchState("https://h.example.com")).kind, "ok");
    globalThis.fetch = (async () => { throw new TypeError("Failed to fetch"); }) as typeof fetch;
    assert.match((await fetchState("https://h.example.com") as { message: string }).message, /Cannot reach the Hub/);
    assert.equal((await fetchState(null as unknown as string)).kind, "unconfigured");
  } finally { globalThis.fetch = real; }
});
