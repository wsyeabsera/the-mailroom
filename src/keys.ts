// Tokens: client keys (mr_live_), daemon credentials (mrd_), their hashes and ids. Pure but for Web Crypto (Workers and Node both have it).
const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const enc = new TextEncoder();

export const KEY_PREFIX = "mr_live_";
export const DAEMON_PREFIX = "mrd_";
export const DISPLAY_PREFIX_LEN = 12;

function base62(n: number): string {
  let out = "";
  const buf = new Uint8Array(1);
  while (out.length < n) {
    crypto.getRandomValues(buf);
    if (buf[0] < 248) out += B62[buf[0] % 62]; // 248 = 62*4, rejects the biased tail
  }
  return out;
}

export const generateKey = (): string => KEY_PREFIX + base62(32);
export const generateDaemonCredential = (): string => DAEMON_PREFIX + base62(32);

/** SHA-256 of the token, hex. Only this is ever stored. */
export async function hashToken(token: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(token));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time string compare (time depends on the longer length only). */
export function safeEqual(a: string, b: string): boolean {
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** Compare two secrets of any length without leaking it: hash both first. */
export async function safeEqualSecret(a: string, b: string): Promise<boolean> {
  return safeEqual(await hashToken(a), await hashToken(b));
}

export const displayPrefix = (key: string): string => key.slice(0, DISPLAY_PREFIX_LEN);
export const credentialHint = (cred: string): string => `${DAEMON_PREFIX}...${cred.slice(-4)}`;

const KEY_RE = /^mr_live_[0-9A-Za-z]{32}$/;
const DAEMON_RE = /^mrd_[0-9A-Za-z]{32}$/;

/** Which kind of token this looks like. A client key is never a daemon credential and the reverse. */
export function tokenKind(token: string): "client" | "daemon" | null {
  return KEY_RE.test(token) ? "client" : DAEMON_RE.test(token) ? "daemon" : null;
}

/** The token from `Authorization: Bearer <token>`, or null. */
export function bearer(header: string | null | undefined): string | null {
  const m = /^Bearer ([^\s]+)$/.exec(header ?? "");
  return m ? m[1] : null;
}

/** Counter-based id: prefix + base36 counter, at least 4 chars (counter starts at 36^3). */
export const makeId = (prefix: string, counter: number): string => `${prefix}${(46656 + counter).toString(36)}`;
