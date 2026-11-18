// Idempotency-Key support for POST /api/jobs. Pure helpers; the Hub keeps the table.
export const IDEMPOTENCY_TTL_MS = 24 * 3600_000;

/** A valid key is 1..200 printable ASCII characters. Returns the key, null if absent, or "invalid". */
export function parseIdempotencyKey(header: string | null): string | null | "invalid" {
  if (header === null) return null;
  const k = header.trim();
  return /^[\x21-\x7e]{1,200}$/.test(k) ? k : "invalid";
}

/** JSON with object keys sorted, so the same request in a different key order has the same fingerprint. */
export function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().filter((k) => (v as any)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stableStringify((v as any)[k])}`).join(",")}}`;
  return JSON.stringify(v) ?? "null";
}

export const fingerprint = (task: string, args: unknown) => stableStringify({ task, args });
export const idempotencyFresh = (createdAt: number, now: number) => now - createdAt < IDEMPOTENCY_TTL_MS;
