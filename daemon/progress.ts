export const PROGRESS_PREFIX = "MAILROOM_PROGRESS ";
export const MAX_TEXT = 500;
export type Progress = { text: string; pct?: number };

/** Parses one stderr line: `MAILROOM_PROGRESS [<pct> ]<text>`. Returns null if it is not a progress line. */
export function parseProgressLine(line: string): Progress | null {
  line = line.replace(/\r$/, "");
  if (!line.startsWith(PROGRESS_PREFIX)) return null;
  let rest = line.slice(PROGRESS_PREFIX.length).trim();
  let pct: number | undefined;
  const m = /^(\d+(?:\.\d+)?)(?:\s+|$)/.exec(rest);
  if (m && Number(m[1]) <= 100) {
    pct = Number(m[1]);
    rest = rest.slice(m[0].length).trim();
  }
  const text = rest.slice(0, MAX_TEXT);
  if (!text && pct === undefined) return null;
  return pct === undefined ? { text } : { text, pct };
}

/** Wraps `send` so it fires at most once per `ms`; the latest skipped value is sent when the window ends. */
export function throttle<T>(send: (v: T) => void, ms = 500): { push(v: T): void; stop(): void } {
  let last = 0;
  let pending: { v: T } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    timer = null;
    if (!pending) return;
    const { v } = pending;
    pending = null;
    last = Date.now();
    send(v);
  };
  return {
    push(v) {
      pending = { v };
      const wait = last + ms - Date.now();
      if (wait <= 0) {
        if (timer) clearTimeout(timer);
        flush();
      } else if (!timer) timer = setTimeout(flush, wait);
    },
    stop() {
      if (timer) clearTimeout(timer);
      timer = null;
      pending = null;
    },
  };
}
