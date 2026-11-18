import { test } from "node:test";
import assert from "node:assert/strict";
import { extractJson, parseAnswer } from "../shared/json-schema.ts";

const schema = { type: "object", required: ["items"], properties: { items: { type: "array", items: { type: "string" } } } };
const ok = (t: string) => (extractJson(t) as any).value;

test("prose before and after valid JSON is dropped", () => {
  assert.deepEqual(ok('Sure, here it is:\n{"items":["a"]}\nHope that helps.'), { items: ["a"] });
  const r = parseAnswer(schema, 'One sentence first. {"items":["a","b"]}');
  assert.deepEqual(r, { ok: true, value: { items: ["a", "b"] } });
});

test("two objects: the first one wins", () => {
  assert.deepEqual(ok('{"items":["x"]} and then {"items":["y"]}'), { items: ["x"] });
});

test("nested braces and brackets inside strings do not confuse the reader", () => {
  assert.deepEqual(ok('Result: {"items":["a } b","c ] \\" { d"]} done'), { items: ["a } b", "c ] \" { d"] });
});

test("an array in prose is found too", () => {
  assert.deepEqual(ok("The list is [1, 2, 3] as asked."), [1, 2, 3]);
});

test("a braces-looking prefix that is not JSON is skipped", () => {
  assert.deepEqual(ok('Use {name} like this: {"items":[]}'), { items: [] });
});

test("truncated JSON fails, and never returns an inner piece", () => {
  assert.equal(extractJson('Here: {"items":["a"],"more":[1,2').ok, false);
  const r = parseAnswer(schema, 'Here: {"items":["a"],"more":{"k":[1]}') as any;
  assert.equal(r.ok, false);
  assert.match(r.error, /not valid JSON/);
});

test("extracted JSON is still validated against the schema, and the error shows no reply text", () => {
  const r = parseAnswer(schema, 'prose secret-words {"items":[5]}') as any;
  assert.equal(r.ok, false);
  assert.match(r.error, /\$\.items\[0\]/);
  assert.doesNotMatch(r.error, /secret/);
});

test("the whole-text and fenced forms still work", () => {
  assert.deepEqual(ok('{"items":[]}'), { items: [] });
  assert.deepEqual(ok('```json\n{"items":["z"]}\n```'), { items: ["z"] });
});

test("no JSON at all fails", () => {
  assert.equal(extractJson("Here you go.").ok, false);
});
