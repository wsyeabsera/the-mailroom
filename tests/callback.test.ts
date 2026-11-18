import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { blockedHost, buildCallbackBody, callbackAtSubmit, checkCallbackUrl, deliverCallback, parseCallbackUrl, signBody, validateCallbackPrefixes, CALLBACK_MAX_RESULT } from "../shared/callback.ts";
import { validateContract } from "../shared/contract.ts";
import { buildPush } from "../src/notify.ts";

const P = ["https://hooks.example.com/mailroom/"];

test("the SSRF guard blocks local, private and IP-literal hosts", () => {
  for (const u of ["https://localhost/x", "https://foo.localhost/x", "https://127.0.0.1/x", "https://10.0.0.5/x", "https://192.168.1.1/x", "https://169.254.169.254/x",
    "https://[::1]/x", "https://[fd00::1]/x", "https://2130706433/x", "https://0x7f.1/x", "https://printer.local/x", "https://db.internal/x", "https://intranet/x", "https://user:pw@hooks.example.com/x", "http://hooks.example.com/x", "ftp://hooks.example.com/x"])
    assert.equal(parseCallbackUrl(u).ok, false, u);
  assert.equal(parseCallbackUrl("https://hooks.example.com/x").ok, true);
  assert.equal(blockedHost("hooks.example.com"), null);
});

test("allowLocal (test flag) lets http and local hosts through, but not credentials", () => {
  assert.equal(parseCallbackUrl("http://127.0.0.1:8802/hook/", { allowLocal: true }).ok, true);
  assert.equal(parseCallbackUrl("http://u:p@127.0.0.1/", { allowLocal: true }).ok, false);
  assert.equal(parseCallbackUrl("ftp://127.0.0.1/", { allowLocal: true }).ok, false);
});

test("contract prefixes: missing means none, must be https and end with /", () => {
  assert.deepEqual(validateCallbackPrefixes(undefined), { ok: true, prefixes: [] });
  assert.deepEqual(validateCallbackPrefixes(P), { ok: true, prefixes: P });
  for (const bad of [["https://hooks.example.com/mailroom"], ["https://hooks.example.com/a?x=1"], ["http://hooks.example.com/"], ["https://127.0.0.1/"], "nope", [5], ["https://hooks.example.com/a#b"]])
    assert.equal(validateCallbackPrefixes(bad).ok, false, JSON.stringify(bad));
});

test("validateContract carries callbackUrls only when set and reports a bad one by field", () => {
  const base = { name: "C", folders: ["~/x"], tasks: ["echo"], dailyLimit: 5, approval: [] };
  const none = validateContract(base);
  assert.ok(none.ok && !("callbackUrls" in none.contract));
  const some = validateContract({ ...base, callbackUrls: P });
  assert.ok(some.ok && some.contract.callbackUrls?.[0] === P[0]);
  const bad = validateContract({ ...base, callbackUrls: ["http://x.com/"] });
  assert.ok(!bad.ok && /https/.test(bad.errors.callbackUrls));
});

test("a callback_url must sit under an allowed prefix (no host or path tricks)", () => {
  assert.equal(checkCallbackUrl("https://hooks.example.com/mailroom/job", P).ok, true);
  for (const u of ["https://hooks.example.com/other", "https://hooks.example.com.evil.net/mailroom/x", "https://hooks.example.com/mailroom/../admin", "https://hooks.example.com@evil.net/mailroom/", "https://evil.net/https://hooks.example.com/mailroom/"])
    assert.equal(checkCallbackUrl(u, P).ok, false, u);
  assert.equal(checkCallbackUrl("https://hooks.example.com/mailroom/x", []).ok, false);
});

test("submit: no callback_url is fine, no CALLBACK_SECRET is a 422, a bad url is a 422", () => {
  assert.deepEqual(callbackAtSubmit(undefined, [], false), { ok: true, url: null });
  const noSecret = callbackAtSubmit("https://hooks.example.com/mailroom/x", P, false);
  assert.ok(!noSecret.ok && noSecret.status === 422 && /CALLBACK_SECRET/.test(noSecret.reason));
  assert.ok(!callbackAtSubmit("https://evil.net/", P, true).ok);
  assert.deepEqual(callbackAtSubmit("https://hooks.example.com/mailroom/x", P, true), { ok: true, url: "https://hooks.example.com/mailroom/x" });
});

test("body: result for done, reason otherwise, big result becomes a link", () => {
  assert.deepEqual(JSON.parse(buildCallbackBody({ id: "p_1", state: "done", result: { echo: "hi" } }, "L")), { id: "p_1", state: "done", result: { echo: "hi" } });
  assert.deepEqual(JSON.parse(buildCallbackBody({ id: "p_1", state: "failed", reason: "boom" }, "L")), { id: "p_1", state: "failed", reason: "boom" });
  const big = JSON.parse(buildCallbackBody({ id: "p_1", state: "done", result: { text: "x".repeat(CALLBACK_MAX_RESULT) } }, "https://h/api/jobs/p_1"));
  assert.deepEqual(big, { id: "p_1", state: "done", result_truncated: true, link: "https://h/api/jobs/p_1" });
});

test("signature is sha256= hex HMAC of the body", async () => {
  assert.equal(await signBody("s3cret", '{"a":1}'), "sha256=" + createHmac("sha256", "s3cret").update('{"a":1}').digest("hex"));
});

test("delivery: succeeds on 2xx, retries up to 3 with backoff, never follows redirects, error has no url", async () => {
  const sleeps: number[] = [];
  const mk = (codes: (number | "throw")[]) => {
    const calls: any[] = [];
    const f = (async (u: string, i: any) => {
      calls.push({ u, i });
      const c = codes[calls.length - 1];
      if (c === "throw") throw new Error("down https://secret.example");
      return new Response(null, { status: c as number });
    }) as unknown as typeof fetch;
    return { calls, fetch: f };
  };
  const base = { url: "https://hooks.example.com/mailroom/x", body: "{}", secret: "s", sleep: async (ms: number) => { sleeps.push(ms); } };
  let m = mk([200]);
  assert.deepEqual(await deliverCallback({ ...base, fetch: m.fetch }), { ok: true, attempts: 1 });
  assert.equal(m.calls[0].i.redirect, "manual");
  assert.match(m.calls[0].i.headers["x-mailroom-signature"], /^sha256=[0-9a-f]{64}$/);
  m = mk([500, "throw", 204]);
  assert.deepEqual(await deliverCallback({ ...base, fetch: m.fetch }), { ok: true, attempts: 3 });
  assert.deepEqual(sleeps, [1000, 4000]);
  m = mk([500, 302, "throw", 200]);
  const r = await deliverCallback({ ...base, fetch: m.fetch });
  assert.equal(r.ok, false);
  assert.equal(r.attempts, 3);
  assert.equal(m.calls.length, 3);
  assert.ok(!JSON.stringify(r).includes("secret.example"));
});

test("push text has only the task, key label and approval link, and is header-safe", () => {
  const p = buildPush("write_file", "My Key \u{1F511}", "https://mail.example.workers.dev");
  assert.equal(p.title, "Mailroom: write_file needs approval");
  assert.equal(p.click, "https://mail.example.workers.dev/#/approvals");
  assert.match(p.body, /^write_file from My Key \?+\. Open https:\/\/mail\.example\.workers\.dev\/#\/approvals$/);
  assert.ok(/^[\x20-\x7E]*$/.test(p.title + p.body));
});
