// Job-done callbacks: the URL rules (an SSRF guard), the body, the signature and the retrying delivery.
// Pure apart from the fetch and sleep a caller injects, so node --test covers it without a network.
// These are decisions made on the owner's behalf (see docs/api.md, "Callbacks"): https only, no IP literals, no local names,
// and a URL must start with a prefix the contract lists.

export const CALLBACK_MAX_RESULT = 8 * 1024; // bytes of result JSON sent inline; bigger results are replaced by a link
export const CALLBACK_ATTEMPTS = 3;
export const CALLBACK_BACKOFF_MS = [1000, 4000]; // waits before attempt 2 and 3
export const CALLBACK_TIMEOUT_MS = 5000;
export const FINAL_STATES = ["done", "failed", "refused", "cancelled"] as const;

export type UrlOpts = { allowLocal?: boolean }; // test-only: lets http and local hosts through (MAILROOM_ALLOW_LOCAL_URLS)

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const LOCAL_SUFFIXES = [".localhost", ".local", ".localdomain", ".internal", ".lan", ".home.arpa", ".intranet", ".corp"];

/** Why a host may not be called, or null. Works on URL.hostname (the parser has already turned 2130706433 or 0x7f.1 into dotted form). */
export function blockedHost(hostname: string): string | null {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  if (h === "") return "the URL has no host";
  if (h.startsWith("[") || h.includes(":")) return "an IP address (IPv6) is not allowed, use a host name";
  if (IPV4.test(h)) return "an IP address is not allowed (this also covers private and link-local ranges), use a host name";
  if (h === "localhost" || LOCAL_SUFFIXES.some((s) => h.endsWith(s))) return "a local host name is not allowed";
  if (!h.includes(".")) return "a host name without a dot is not allowed";
  return null;
}

/** Parses and guards one URL. Returns the URL or why not. Never throws. */
export function parseCallbackUrl(raw: unknown, opts: UrlOpts = {}): { ok: true; url: URL } | { ok: false; reason: string } {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 500) return { ok: false, reason: "must be a URL string of up to 500 characters" };
  let url: URL;
  try { url = new URL(raw.trim()); } catch { return { ok: false, reason: "is not a valid URL" }; }
  if (url.protocol !== "https:" && !(opts.allowLocal && url.protocol === "http:")) return { ok: false, reason: "must be https" };
  if (url.username || url.password) return { ok: false, reason: "must not contain a user name or password" };
  if (!opts.allowLocal) {
    const why = blockedHost(url.hostname);
    if (why) return { ok: false, reason: why };
  }
  return { ok: true, url };
}

/** Contract field `callbackUrls`: missing or null means none. Each entry is an https prefix that ends with "/". */
export function validateCallbackPrefixes(raw: unknown, opts: UrlOpts = {}): { ok: true; prefixes: string[] } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, prefixes: [] };
  if (!Array.isArray(raw) || raw.length > 20) return { ok: false, error: "Callback URLs must be a list of up to 20 https addresses." };
  const out: string[] = [];
  for (const p of raw) {
    const r = parseCallbackUrl(p, opts);
    const shown = String(p).slice(0, 80);
    if (!r.ok) return { ok: false, error: `“${shown}” ${r.reason}.` };
    if (r.url.search || r.url.hash) return { ok: false, error: `“${shown}” must not have a ? or # part.` };
    if (!r.url.href.endsWith("/")) return { ok: false, error: `“${shown}” must end with /, so it cannot also match a longer host name.` };
    if (!out.includes(r.url.href)) out.push(r.url.href);
  }
  return { ok: true, prefixes: out };
}

/** A job's callback_url must pass the guard and start with one of the contract's prefixes (compared after URL normalisation, so ../ tricks do not help). */
export function checkCallbackUrl(raw: unknown, prefixes: string[], opts: UrlOpts = {}): { ok: true; url: string } | { ok: false; reason: string } {
  const r = parseCallbackUrl(raw, opts);
  if (!r.ok) return { ok: false, reason: `callback_url ${r.reason}.` };
  if (!prefixes.some((p) => r.url.href.startsWith(p))) return { ok: false, reason: "callback_url is not under any callback URL this key's contract allows." };
  return { ok: true, url: r.url.href };
}

/** Everything the submit route decides about callback_url. A refusal is always 422 (the client can fix it). */
export function callbackAtSubmit(raw: unknown, prefixes: string[], secretSet: boolean, opts: UrlOpts = {}): { ok: true; url: string | null } | { ok: false; status: 422; reason: string } {
  if (raw === undefined || raw === null) return { ok: true, url: null };
  if (!secretSet) return { ok: false, status: 422, reason: "callback_url is not available: the owner has not set CALLBACK_SECRET on the Hub, so a callback could not be signed." };
  const c = checkCallbackUrl(raw, prefixes, opts);
  return c.ok ? { ok: true, url: c.url } : { ok: false, status: 422, reason: c.reason };
}

type Ended = { id: string; state: string; reason?: string | null; result?: unknown };

/** The JSON body: {id, state, result} for a job that ran, {id, state, reason} otherwise. A big result is replaced by result_truncated and a link. */
export function buildCallbackBody(job: Ended, link: string): string {
  const body: Record<string, unknown> = { id: job.id, state: job.state };
  if (job.state === "done") {
    const r = JSON.stringify(job.result ?? null);
    if (new TextEncoder().encode(r).length > CALLBACK_MAX_RESULT) Object.assign(body, { result_truncated: true, link });
    else body.result = job.result ?? null;
  } else body.reason = typeof job.reason === "string" ? job.reason.slice(0, 2000) : null;
  return JSON.stringify(body);
}

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** `sha256=<hex HMAC-SHA256 of the exact body bytes>`, the X-Mailroom-Signature value. */
export async function signBody(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return "sha256=" + hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
}

export type DeliverOpts = {
  url: string; body: string; secret: string;
  fetch: typeof fetch; sleep: (ms: number) => Promise<void>;
  attempts?: number; backoffMs?: number[]; timeoutMs?: number;
};

/** POSTs the body, at most `attempts` times with backoff. Success is a 2xx; redirects are never followed. Never throws; the error text has no URL. */
export async function deliverCallback(o: DeliverOpts): Promise<{ ok: boolean; attempts: number; error?: string }> {
  const attempts = o.attempts ?? CALLBACK_ATTEMPTS;
  const backoff = o.backoffMs ?? CALLBACK_BACKOFF_MS;
  const signature = await signBody(o.secret, o.body);
  let error = "";
  for (let n = 1; n <= attempts; n++) {
    if (n > 1) await o.sleep(backoff[Math.min(n - 2, backoff.length - 1)] ?? 1000);
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), o.timeoutMs ?? CALLBACK_TIMEOUT_MS);
    try {
      const res = await o.fetch(o.url, { method: "POST", redirect: "manual", signal: ctl.signal, headers: { "content-type": "application/json", "x-mailroom-signature": signature, "user-agent": "the-mailroom" }, body: o.body });
      if (res.status >= 200 && res.status < 300) return { ok: true, attempts: n };
      error = `HTTP ${res.status}`;
    } catch {
      error = ctl.signal.aborted ? "timed out" : "network error";
    } finally {
      clearTimeout(t);
    }
  }
  return { ok: false, attempts, error };
}
