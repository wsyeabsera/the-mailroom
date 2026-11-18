import WebSocket from "ws";
import { loadLastSeq, saveLastSeq } from "./config.ts";
import type { Config } from "./config.ts";
import { commandTimeouts } from "./commands.ts";
import { hintsFromTimeouts, laneOf, type Lane } from "../shared/lanes.ts";
import { recheck, runTask } from "./tasks.ts";
import { listReport } from "./commands.ts";
import { throttle } from "./progress.ts";
import { rerunSafeCommands } from "./commands.ts";
import { listPromptReport } from "./prompts.ts";
import { MAX_RESULT_BYTES } from "../shared/limits.ts";
import type { JobMsg } from "./tasks.ts";

export const VERSION = "0.2.0";

export const wsUrl = (url: string) => url.replace(/^http/, "ws").replace(/\/+$/, "") + "/daemon";

export type Fatal = { code: number; message: string };

/** Ask the Hub whether it accepts this credential, without connecting as a daemon (a second daemon socket would
 *  replace the running one). Used by `status` and `service status`. */
export async function probe(cfg: Config): Promise<string> {
  try {
    const res = await fetch(`${cfg.url.replace(/\/+$/, "")}/daemon?probe=1`, { headers: { Authorization: `Bearer ${cfg.credential}` }, signal: AbortSignal.timeout(8000) });
    if (res.status === 200) {
      const j = (await res.json().catch(() => ({}))) as { connected?: boolean };
      return j.connected ? "accepted (a laptop is connected)" : "accepted (no laptop connected right now)";
    }
    if (res.status === 401) return "rejected (credential not accepted)";
    if (res.status === 426) return "unknown (this Hub is older than v0.3.3 and has no safe check; redeploy the Hub, or use `mailroom run`)";
    return `unexpected HTTP ${res.status}`;
  } catch (e) {
    return `unreachable (${(e as Error).message})`;
  }
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
      const queues: Record<Lane, JobMsg[]> = { short: [], long: [] }; // strict order within a lane
      const cancelled = new Set<string>();
      const running = new Map<string, AbortController>(); // job id -> its abort controller, one per busy lane
      const working: Record<Lane, boolean> = { short: false, long: false };
      const send = (m: unknown) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m));

      const pump = async (lane: Lane) => {
        if (working[lane]) return;
        working[lane] = true;
        const queue = queues[lane];
        while (queue.length && ws.readyState === WebSocket.OPEN) {
          const job = queue.shift()!;
          if (cancelled.delete(job.id)) continue;
          const verdict = recheck(job);
          if ("reason" in verdict) {
            send({ type: "refuse", id: job.id, reason: verdict.reason });
            continue;
          }
          const abort = new AbortController();
          running.set(job.id, abort);
          const progress = throttle<{ text: string; pct?: number }>(p => send({ type: "progress", id: job.id, ...p }), 500);
          try {
            const result = await runTask(job, verdict.resolved, abort.signal, (text, pct) => progress.push(pct === undefined ? { text } : { text, pct }));
            progress.stop();
            if (!abort.signal.aborted) {
              // The Hub refuses a result over the cap; say so here, in words, instead of sending megabytes it will drop.
              if (Buffer.byteLength(JSON.stringify(result) ?? "null") > MAX_RESULT_BYTES) send({ type: "result", id: job.id, ok: false, error: `result is bigger than ${MAX_RESULT_BYTES / 1024 / 1024} MB` });
              else send({ type: "result", id: job.id, ok: true, result });
            }
          } catch (e) {
            progress.stop();
            if (!abort.signal.aborted) send({ type: "result", id: job.id, ok: false, error: (e as Error).message });
          }
          running.delete(job.id);
        }
        working[lane] = false;
      };

      ws.on("open", () => send({ type: "hello", version: VERSION, last_seq: loadLastSeq(), commands: listReport(), rerunSafe: rerunSafeCommands(), prompts: listPromptReport(), lanes: { commands: hintsFromTimeouts(commandTimeouts()) } }));
      ws.on("message", raw => {
        let m: any;
        try {
          m = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (m.type === "ping") send({ type: "pong", id: m.id });
        else if (m.type === "welcome") {
          delay = 1000;
          if (Number.isInteger(m.server_seq)) saveLastSeq(m.server_seq);
          log("connected to the Hub");
        } else if (m.type === "job" && typeof m.id === "string") {
          // The Hub names the lane; fall back to our own rule if it did not (never trust it beyond the two names).
          const lane: Lane = m.lane === "short" || m.lane === "long" ? m.lane : laneOf(m.task, m.args);
          queues[lane].push(m);
          void pump(lane);
        } else if (m.type === "cancel") {
          const abort = running.get(m.id);
          if (abort) abort.abort();
          else if (queues.short.some(j => j.id === m.id) || queues.long.some(j => j.id === m.id)) cancelled.add(m.id);
        }
      });
      ws.on("unexpected-response", (_q, res) => {
        ws.terminate();
        if (res.statusCode === 401) fatal({ code: 4001, message: "The Hub did not accept this credential (rotated or wrong). Run `mailroom login` again." });
        else retry(`Hub answered HTTP ${res.statusCode}`);
      });
      ws.on("error", () => {}); // 'close' follows
      ws.on("close", code => {
        for (const a of running.values()) a.abort(); // the Hub requeues running jobs when we drop
        queues.short.length = 0;
        queues.long.length = 0;
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
