// Owner session: cookie `mr_session` = `exp.hmac`, hmac = HMAC-SHA256(secret, "mailroom-session:" + exp). Pure but for Web Crypto.
import { safeEqual } from "./keys.ts";

export const SESSION_COOKIE = "mr_session";
export const SESSION_SECONDS = 7 * 24 * 3600;
const enc = new TextEncoder();

async function mac(secret: string, exp: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(`mailroom-session:${exp}`));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function signSession(secret: string, exp: number): Promise<string> {
  return `${exp}.${await mac(secret, exp)}`;
}

/** True for a well-formed, unexpired value signed with this secret. Without a secret no session is valid. */
export async function verifySession(secret: string | undefined, value: string | undefined, nowMs = Date.now()): Promise<boolean> {
  const m = secret && value ? /^(\d{1,12})\.([0-9a-f]{64})$/.exec(value) : null;
  if (!m || !secret) return false;
  const exp = Number(m[1]);
  return exp > Math.floor(nowMs / 1000) && safeEqual(m[2], await mac(secret, exp));
}

export function cookieValue(header: string | null, name = SESSION_COOKIE): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

export function sessionCookie(value: string, maxAge: number, secure: boolean): string {
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

export const sessionOk = (request: Request, secret: string | undefined, nowMs = Date.now()): Promise<boolean> =>
  verifySession(secret, cookieValue(request.headers.get("Cookie")), nowMs);
