// The Worker: routing and the owner gate. Everything stateful lives in the Hub.
import { sessionOk } from "./session.ts";
import type { Env } from "./hub.ts";

export { Hub } from "./hub.ts";

const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
/** Files an unauthenticated visitor may load: the sign-in page and its own assets. */
const PUBLIC = /^\/(login(\.html|\.js|\.css|\.svg)?|login\/.*)$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const hub = env.HUB.get(env.HUB.idFromName("hub"));
    const forward = (extra: Record<string, string> = {}) => {
      const h = new Headers(request.headers);
      h.delete("X-Mr-IP");
      h.delete("X-Mr-Secure");
      h.set("X-Mr-IP", request.headers.get("CF-Connecting-IP") ?? "local");
      h.set("X-Mr-Secure", url.protocol === "https:" && !["localhost", "127.0.0.1"].includes(url.hostname) ? "1" : "0");
      for (const [k, v] of Object.entries(extra)) h.set(k, v);
      return hub.fetch(new Request(request, { headers: h }));
    };

    // Handled before the owner gate: they carry their own credentials.
    if (path === "/daemon" || path === "/api/jobs" || path.startsWith("/api/jobs/")) return forward();
    if (path.startsWith("/api/")) return json({ error: "not_found" }, 404);

    const unsafe = request.method !== "GET" && request.method !== "HEAD";
    if (path.startsWith("/admin/") && unsafe) {
      const origin = request.headers.get("Origin");
      if (origin !== null && origin !== url.origin) return json({ error: "bad_origin" }, 403);
    }
    if (path === "/admin/login") return forward();

    const authed = await sessionOk(request, env.SESSION_SECRET);
    if (path.startsWith("/admin/")) return authed ? forward() : json({ error: "signed_out" }, 401);

    if (request.method !== "GET" && request.method !== "HEAD") return json({ error: "not_found" }, 404);
    if (authed) return env.ASSETS.fetch(request);
    if (PUBLIC.test(path)) {
      let res = await env.ASSETS.fetch(path === "/login" ? new Request(new URL("/login.html", url), request) : request);
      if (res.status >= 300 && res.status < 400 && res.headers.get("Location")) res = await env.ASSETS.fetch(new Request(new URL(res.headers.get("Location")!, url), request));
      return res;
    }
    return new Response(null, { status: 302, headers: { Location: "/login", "cache-control": "no-store" } });
  },
};
