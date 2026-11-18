// A small JSON Schema checker for the answers of `ask` prompts. Pure, no dependency.
// Supports: type (object, array, string, number, integer, boolean, null; one name or a list), properties, required, items,
// enum, minLength, maxLength, minimum, maximum. Extra object fields are allowed. Anything else in a schema is ignored.

export type Violation = { path: string; message: string };

const typeOf = (v: unknown): string => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
const isType = (v: unknown, t: string): boolean => (t === "integer" ? typeof v === "number" && Number.isInteger(v) : t === "number" ? typeof v === "number" && Number.isFinite(v) : typeOf(v) === t);
const key = (k: string) => (/^[A-Za-z_$][\w$]*$/.test(k) ? `.${k}` : `[${JSON.stringify(k)}]`);

/** Returns the first violation (in schema order: type, enum, bounds, required, properties, items) or null when `value` matches. */
export function validate(schema: unknown, value: unknown, path = "$", depth = 0): Violation | null {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return null;
  if (depth > 32) return { path, message: "is nested too deeply" };
  const s = schema as Record<string, unknown>;

  if (s.type !== undefined) {
    const types = Array.isArray(s.type) ? s.type : [s.type];
    if (!types.some(t => typeof t === "string" && isType(value, t))) return { path, message: `expected ${types.join(" or ")}, got ${typeOf(value)}` };
  }
  if (Array.isArray(s.enum) && !s.enum.some(e => JSON.stringify(e) === JSON.stringify(value))) return { path, message: `must be one of ${s.enum.map(e => JSON.stringify(e)).join(", ")}` };

  if (typeof value === "string") {
    if (typeof s.minLength === "number" && value.length < s.minLength) return { path, message: `must be at least ${s.minLength} characters (got ${value.length})` };
    if (typeof s.maxLength === "number" && value.length > s.maxLength) return { path, message: `must be at most ${s.maxLength} characters (got ${value.length})` };
  }
  if (typeof value === "number") {
    if (typeof s.minimum === "number" && value < s.minimum) return { path, message: `must be at least ${s.minimum} (got ${value})` };
    if (typeof s.maximum === "number" && value > s.maximum) return { path, message: `must be at most ${s.maximum} (got ${value})` };
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const o = value as Record<string, unknown>;
    if (Array.isArray(s.required))
      for (const r of s.required) if (typeof r === "string" && !Object.hasOwn(o, r)) return { path: path + key(r), message: "is required" };
    if (s.properties && typeof s.properties === "object" && !Array.isArray(s.properties))
      for (const [k, sub] of Object.entries(s.properties as Record<string, unknown>)) {
        if (!Object.hasOwn(o, k)) continue;
        const v = validate(sub, o[k], path + key(k), depth + 1);
        if (v) return v;
      }
  }
  if (Array.isArray(value) && s.items !== undefined) {
    for (let i = 0; i < value.length; i++) {
      const v = validate(s.items, value[i], `${path}[${i}]`, depth + 1);
      if (v) return v;
    }
  }
  return null;
}

/** The end index (exclusive) of the balanced object or array starting at `start`, aware of strings and escapes; -1 when it never closes. */
function balancedEnd(t: string, start: number): number {
  let depth = 0;
  let inStr = false;
  for (let i = start; i < t.length; i++) {
    const c = t[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** Lenient reader: the whole text as JSON, else (a code fence tolerated) the first balanced object or array in it that parses.
 *  Text around it is dropped. A candidate that never closes (a truncated reply) ends the search, since all that follows is inside it. */
export function extractJson(text: string): { ok: true; value: unknown } | { ok: false } {
  let t = text.trim();
  const fence = /^```[\w-]*\s*\n([\s\S]*?)\n?```$/.exec(t);
  if (fence) t = fence[1].trim();
  try {
    return { ok: true, value: JSON.parse(t) };
  } catch { /* look inside */ }
  for (let i = 0; i < t.length; i++) {
    if (t[i] !== "{" && t[i] !== "[") continue;
    const end = balancedEnd(t, i);
    if (end < 0) return { ok: false };
    try {
      return { ok: true, value: JSON.parse(t.slice(i, end)) };
    } catch {
      i = end - 1;
    }
  }
  return { ok: false };
}

/** Reads Claude's text answer as JSON (see extractJson: a fence or text around it is tolerated, and dropped) and validates it. The error names the path of the
 *  first violation and the reply's length, never its text. */
export function parseAnswer(schema: unknown, text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const len = `reply was ${text.length} characters`;
  const r = extractJson(text);
  if (!r.ok) return { ok: false, error: `answer is not valid JSON (it may be truncated; ${len})` };
  const value = r.value;
  const v = validate(schema, value);
  if (v) return { ok: false, error: `answer does not match the schema at ${v.path}: ${v.message} (${len})` };
  return { ok: true, value };
}
