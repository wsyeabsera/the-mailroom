import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAnswer, validate } from "../shared/json-schema.ts";

const streams = { type: "object", required: ["streams"], properties: { streams: { type: "array", items: { type: "object", required: ["url"], properties: { url: { type: "string", minLength: 1, maxLength: 20 }, score: { type: "number", minimum: 0, maximum: 1 }, kind: { enum: ["hls", "dash"] } } } } } };

test("a matching value passes, extra fields are allowed", () => {
  assert.equal(validate(streams, { streams: [{ url: "http://a", score: 0.5, kind: "hls", extra: true }], more: 1 }), null);
  assert.equal(validate(streams, { streams: [] }), null);
});

test("type: each type, integer, and a list of types", () => {
  assert.equal(validate({ type: "integer" }, 3), null);
  assert.deepEqual(validate({ type: "integer" }, 3.5), { path: "$", message: "expected integer, got number" });
  assert.equal(validate({ type: "number" }, "3")?.message, "expected number, got string");
  assert.equal(validate({ type: "boolean" }, 0)?.message, "expected boolean, got number");
  assert.equal(validate({ type: "array" }, {})?.message, "expected array, got object");
  assert.equal(validate({ type: "object" }, [])?.message, "expected object, got array");
  assert.equal(validate({ type: "object" }, null)?.message, "expected object, got null");
  assert.equal(validate({ type: ["string", "null"] }, null), null);
  assert.equal(validate({ type: "null" }, 1)?.message, "expected null, got number");
  assert.equal(validate({ type: "number" }, NaN)?.message, "expected number, got number");
});

test("the first violation names its path", () => {
  assert.deepEqual(validate(streams, {}), { path: "$.streams", message: "is required" });
  assert.deepEqual(validate(streams, { streams: [{ url: "a" }, {}] }), { path: "$.streams[1].url", message: "is required" });
  assert.deepEqual(validate(streams, { streams: [{ url: 5 }] }), { path: "$.streams[0].url", message: "expected string, got number" });
  assert.equal(validate(streams, { streams: [{ url: "x".repeat(21) }] })?.path, "$.streams[0].url");
  assert.match(validate(streams, { streams: [{ url: "x".repeat(21) }] })!.message, /at most 20 characters/);
  assert.match(validate(streams, { streams: [{ url: "" }] })!.message, /at least 1/);
  assert.equal(validate(streams, { streams: [{ url: "a", score: 2 }] })?.path, "$.streams[0].score");
  assert.match(validate(streams, { streams: [{ url: "a", score: -1 }] })!.message, /at least 0/);
  assert.match(validate(streams, { streams: [{ url: "a", kind: "rtmp" }] })!.message, /one of "hls", "dash"/);
  assert.equal(validate({ properties: { "a b": { type: "string" } } }, { "a b": 1 })?.path, '$["a b"]');
});

test("keywords this validator does not know are ignored; non-object schemas accept anything", () => {
  assert.equal(validate({ type: "string", pattern: "^a", format: "uri" }, "zzz"), null);
  assert.equal(validate(true, 1), null);
  assert.equal(validate(null, 1), null);
});

test("hostile keys do not confuse required or properties", () => {
  assert.deepEqual(validate({ required: ["toString"] }, {}), { path: "$.toString", message: "is required" });
  assert.equal(validate({ properties: { constructor: { type: "string" } } }, JSON.parse('{"__proto__": 1}')), null);
});

test("parseAnswer: parses, tolerates one code fence, returns the parsed value", () => {
  assert.deepEqual(parseAnswer(streams, ' {"streams":[{"url":"a"}]} \n'), { ok: true, value: { streams: [{ url: "a" }] } });
  assert.deepEqual(parseAnswer(streams, '```json\n{"streams":[]}\n```'), { ok: true, value: { streams: [] } });
});

test("parseAnswer: truncated JSON, prose and a mismatch fail with the length, never the text", () => {
  const trunc = '{"streams":[{"url":"http://secret-host/ab';
  const t = parseAnswer(streams, trunc) as { ok: false; error: string };
  assert.equal(t.ok, false);
  assert.match(t.error, /not valid JSON/);
  assert.ok(t.error.includes(`${trunc.length} characters`));
  assert.ok(!t.error.includes("secret-host"));
  assert.match((parseAnswer(streams, "Sure! Here you go.") as any).error, /not valid JSON/);
  const w = parseAnswer(streams, '{"streams":[{"url":7}]}') as { ok: false; error: string };
  assert.match(w.error, /at \$\.streams\[0\]\.url: expected string, got number \(reply was 23 characters\)/);
  assert.match((parseAnswer({ type: "object" }, "[1]") as any).error, /at \$: expected object, got array/);
});
