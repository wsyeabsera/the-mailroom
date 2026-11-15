// Sign-in throttle: at most MAX_FAILS wrong passwords per key (the IP) in WINDOW_S seconds, then a pause until the window ends.
// Pure over a tiny Sql interface; table `login_attempts(key PRIMARY KEY, count, first_at)`.
export interface Sql {
  all<T>(query: string, ...params: unknown[]): T[];
  run(query: string, ...params: unknown[]): void;
}

export const MAX_FAILS = 5;
export const WINDOW_S = 15 * 60;
export const LOGIN_TABLE = "CREATE TABLE IF NOT EXISTS login_attempts (key TEXT PRIMARY KEY, count INTEGER NOT NULL, first_at INTEGER NOT NULL)";

export type Attempt = { locked: false; tries_left: number } | { locked: true; retry_after: number };
type Row = { count: number; first_at: number };

function current(sql: Sql, key: string, now: number): Row | null {
  const [r] = sql.all<Row>("SELECT count, first_at FROM login_attempts WHERE key = ?", key);
  return r && now - r.first_at < WINDOW_S * 1000 ? r : null;
}

const state = (r: Row | null, now: number): Attempt =>
  r && r.count >= MAX_FAILS ? { locked: true, retry_after: Math.ceil((r.first_at + WINDOW_S * 1000 - now) / 1000) } : { locked: false, tries_left: MAX_FAILS - (r?.count ?? 0) };

export const checkLogin = (sql: Sql, key: string, now = Date.now()): Attempt => state(current(sql, key, now), now);

export function recordFailure(sql: Sql, key: string, now = Date.now()): Attempt {
  sql.run("DELETE FROM login_attempts WHERE first_at <= ?", now - WINDOW_S * 1000);
  const r = current(sql, key, now);
  const next = { count: (r?.count ?? 0) + 1, first_at: r?.first_at ?? now };
  sql.run("INSERT INTO login_attempts (key, count, first_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET count = excluded.count, first_at = excluded.first_at", key, next.count, next.first_at);
  return state(next, now);
}

export function clearFailures(sql: Sql, key: string): void {
  sql.run("DELETE FROM login_attempts WHERE key = ?", key);
}
