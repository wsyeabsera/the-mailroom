import WebSocket from "ws";
import { loadLastSeq, saveLastSeq } from "./config.ts";
import type { Config } from "./config.ts";
import { recheck, runTask } from "./tasks.ts";
import type { JobMsg } from "./tasks.ts";

export const VERSION = "0.2.0";

export const wsUrl = (url: string) => url.replace(/^http/, "ws").replace(/\/+$/, "") + "/daemon";

export type Fatal = { code: number; message: string };

/** Connect once and report what the Hub said. Used by `status`. */
export function probe(cfg: Config): Promise<string> {
  return new Promise(resolve => {
    const ws = new WebSocket(wsUrl(cfg.url), { headers: { Authorization: `Bearer ${cfg.credential}` }, handshakeTimeout: 8000 });
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "hello", version: VERSION, last_seq: loadLastSeq() }));
      ws.on("message", () => {
        resolve("accepted");
        ws.close();
      });
    });
    ws.on("unexpected-response", (_q, res) => {
      resolve(res.statusCode === 401 ? "rejected (credential not accepted)" : `unexpected HTTP ${res.statusCode}`);
      ws.terminate();
    });
    ws.on("close", c => resolve(c === 4001 ? "rejected (credential rotated)" : `closed (${c})`));
    ws.on("error", e => resolve(`unreachable (${e.message})`));
  });
}

/** Run until a fatal close (4001, 4002, bad credential). Resolves with the reason; never retries those. */
export function run(cfg: Config, log: (s: string) => void = console.log): Promise<Fatal> {
  return new Promise(done => {
    let delay = 1000;
    let stopped = false;
    const fatal = (f: Fatal) => {
      stopped = true;
      done(f);
    };

    const connect = () => {
      const ws = new WebSocket(wsUrl(cfg.url), { headers: { Authorization: `Bearer ${cfg.credential}` }, handshakeTimeout: 10000 });
      const queue: JobMsg[] = [];
      const cancelled = new Set<string>();
      let current: { id: string; abort: AbortController } | null = null;
      let working = false;
      const send = (m: unknown) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m));

      const pump = async () => {
        if (working) return;
        working = true;
        while (queue.length && ws.readyState === WebSocket.OPEN) {
          const job = queue.shift()!;
          if (cancelled.delete(job.id)) continue;
          const verdict = recheck(job);
          if ("reason" in verdict) {
            send({ type: "refuse", id: job.id, reason: verdict.reason });
            continue;
          }
          const abort = new AbortController();
          current = { id: job.id, abort };
          try {
            const result = await runTask(job, verdict.resolved, abort.signal);
            if (!abort.signal.aborted) send({ type: "result", id: job.id, ok: true, result });
          } catch (e) {
            if (!abort.signal.aborted) send({ type: "result", id: job.id, ok: false, error: (e as Error).message });
          }
          current = null;
        }
        working = false;
      };

      ws.on("open", () => send({ type: "hello", version: VERSION, last_seq: loadLastSeq() }));
      ws.on("message", raw => {
        let m: any;
        try {
          m = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (m.type === "ping") send({ type: "pong" });
        else if (m.type === "welcome") {
          delay = 1000;
          if (Number.isInteger(m.server_seq)) saveLastSeq(m.server_seq);
          log("connected to the Hub");
        } else if (m.type === "job" && typeof m.id === "string") {
          queue.push(m);
          void pump();
        } else if (m.type === "cancel") {
          const cur = current as { id: string; abort: AbortController } | null;
          if (cur && cur.id === m.id) cur.abort.abort();
          else if (queue.some(j => j.id === m.id)) cancelled.add(m.id);
        }
      });
      ws.on("unexpected-response", (_q, res) => {
        ws.terminate();
        if (res.statusCode === 401) fatal({ code: 4001, message: "The Hub did not accept this credential (rotated or wrong). Run `mailroom login` again." });
        else retry(`Hub answered HTTP ${res.statusCode}`);
      });
      ws.on("error", () => {}); // 'close' follows
      ws.on("close", code => {
        current?.abort.abort(); // the Hub requeues running jobs when we drop
        queue.length = 0;
        if (stopped) return;
        if (code === 4001) fatal({ code, message: "The daemon credential was rotated. Run `mailroom login` with the new credential." });
        else if (code === 4002) fatal({ code, message: "Replaced by another daemon. Exiting." });
        else retry(`disconnected (${code})`);
      });
    };

    const retry = (why: string) => {
      if (stopped) return;
      const wait = Math.round(delay * (0.75 + Math.random() * 0.5));
      log(`${why}; reconnecting in ${(wait / 1000).toFixed(1)}s`);
      delay = Math.min(delay * 2, 30000);
      setTimeout(connect, wait);
    };
    connect();
  });
}
