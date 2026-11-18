// Big job results: stored in their own table, expire after BIG_RESULT_TTL_MS. Pure helpers (the SQL stays in the Hub).
import { BIG_RESULT_TTL_MS, INLINE_RESULT_BYTES, MAX_RESULT_BYTES } from "../shared/limits.ts";

const enc = new TextEncoder();
export const bytesOf = (s: string) => enc.encode(s).length;

export type ResultPlan =
  | { kind: "inline"; json: string }
  | { kind: "stored"; marker: string; body: string; bytes: number }
  | { kind: "too_large"; bytes: number };

/** Decides where a serialised result goes. */
export function planResult(json: string): ResultPlan {
  const bytes = bytesOf(json);
  if (bytes > MAX_RESULT_BYTES) return { kind: "too_large", bytes };
  if (bytes <= INLINE_RESULT_BYTES) return { kind: "inline", json };
  return { kind: "stored", marker: JSON.stringify({ $stored: { bytes } }), body: json, bytes };
}

/** If the job row's `result` text is a stored-result marker, its size; otherwise null. */
export function markerBytes(resultText: string | null | undefined): number | null {
  if (!resultText || !resultText.startsWith('{"$stored":')) return null;
  try {
    const b = JSON.parse(resultText).$stored?.bytes;
    return typeof b === "number" ? b : null;
  } catch {
    return null;
  }
}

export const resultExpired = (storedAt: number, now: number) => now - storedAt >= BIG_RESULT_TTL_MS;
export const resultCutoff = (now: number) => now - BIG_RESULT_TTL_MS;
