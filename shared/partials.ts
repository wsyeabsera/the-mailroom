// Partial results: a running job hands over results as it finds them. A `run` script prints a line on stderr:
//   MAILROOM_PARTIAL <json>
// The daemon forwards each one; the Hub keeps the latest MAX_PARTIALS per job (oldest dropped), each at most MAX_PARTIAL_BYTES.
// Pure: no I/O. A partial is untrusted data from the laptop's script or a batch item: stored and served as JSON, never interpreted.
export const PARTIAL_PREFIX = "MAILROOM_PARTIAL ";
export const MAX_PARTIALS = 200;
export const MAX_PARTIAL_BYTES = 8 * 1024;

const byteLength = (s: string) => new TextEncoder().encode(s).length;

/** Parses one stderr line. Returns the JSON value, or undefined when it is not a usable partial line (wrong prefix, bad JSON, too big). */
export function parsePartialLine(line: string): { value: unknown } | undefined {
  line = line.replace(/\r$/, "");
  if (!line.startsWith(PARTIAL_PREFIX)) return undefined;
  const text = line.slice(PARTIAL_PREFIX.length).trim();
  if (!text || byteLength(text) > MAX_PARTIAL_BYTES) return undefined;
  try {
    return { value: JSON.parse(text) };
  } catch {
    return undefined;
  }
}

/** The value as the Hub stores it (JSON text), or null when it must be dropped (does not serialise, or over the size cap). */
export function cleanPartial(v: unknown): string | null {
  let s: string | undefined;
  try {
    s = JSON.stringify(v);
  } catch {
    return null;
  }
  if (s === undefined || byteLength(s) > MAX_PARTIAL_BYTES) return null;
  return s;
}

/** After adding partial number `n`, the lowest number still kept (older ones are dropped). */
export const oldestKept = (n: number): number => n - MAX_PARTIALS + 1;
