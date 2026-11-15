import { WebSocketServer, WebSocket } from "ws";
import http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CRED = "mrd_" + "a".repeat(32);
const CLI = path.resolve(import.meta.dirname, "../daemon/cli.ts");

export class FakeHub {
  wss!: WebSocketServer;
  http!: http.Server;
  probes = 0; // plain GET /daemon?probe=1 checks (what `mailroom status` must use)
  port = 0;
  sockets: WebSocket[] = [];
  auth: (string | undefined)[] = [];
  messages: any[] = []; // everything the daemon sent
  waiters: { pred: (m: any) => boolean; res: (m: any) => void }[] = [];
  onConnect: (ws: WebSocket) => void = ws => ws.send(JSON.stringify({ type: "welcome", server_seq: 7 }));

  async start() {
    // Like the real Hub: GET /daemon?probe=1 checks the credential and never opens a daemon socket.
    this.http = http.createServer((req, res) => {
      const h = req.headers.authorization;
      if (req.url?.startsWith("/daemon?probe=1")) {
        this.probes++;
        if (h === `Bearer ${CRED}`) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true, connected: this.sockets.length > 0 })); }
        else { res.writeHead(401); res.end("no"); }
      } else { res.writeHead(426); res.end(); }
    });
    this.wss = new WebSocketServer({
      server: this.http,
      verifyClient: (info, cb) => {
        const h = info.req.headers.authorization;
        this.auth.push(h);
        h === `Bearer ${CRED}` ? cb(true) : cb(false, 401, "no");
      },
    });
    await new Promise<void>(r => this.http.listen(0, "127.0.0.1", () => r()));
    this.port = (this.http.address() as any).port;
    this.wss.on("connection", ws => {
      this.sockets.push(ws);
      ws.on("message", raw => {
        const m = JSON.parse(String(raw));
        this.messages.push(m);
        this.waiters = this.waiters.filter(w => (w.pred(m) ? (w.res(m), false) : true));
      });
      this.onConnect(ws);
    });
  }
  get url() { return `http://127.0.0.1:${this.port}`; }
  get ws() { return this.sockets[this.sockets.length - 1]; }
  push(m: unknown) { this.ws.send(JSON.stringify(m)); }
  waitFor(pred: (m: any) => boolean, ms = 8000): Promise<any> {
    const have = this.messages.find(pred);
    if (have) return Promise.resolve(have);
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error("timeout waiting for message")), ms);
      this.waiters.push({ pred, res: m => (clearTimeout(t), res(m)) });
    });
  }
  async stop() {
    for (const c of this.wss.clients) c.terminate();
    await new Promise(r => this.wss.close(r));
    await new Promise(r => this.http.close(r));
  }
}

export function tmpHome() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mr-home-")));
  return home;
}

export function cli(home: string, args: string[], env: Record<string, string> = {}): ChildProcess & { out: () => string; exited: Promise<number | null> } {
  const p = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, HOME: home, ...env }, stdio: ["ignore", "pipe", "pipe"] }) as any;
  let buf = "";
  p.stdout.on("data", (d: Buffer) => (buf += d));
  p.stderr.on("data", (d: Buffer) => (buf += d));
  p.out = () => buf;
  p.exited = new Promise(r => p.on("exit", (c: number | null) => r(c)));
  return p;
}

export function contract(home: string, over: Record<string, unknown> = {}) {
  return { name: "t", folders: ["~/allowed"], tasks: ["echo", "read_file", "write_file", "claude"], dailyLimit: 100, expires: null, approval: [], ...over };
}

export const job = (id: string, task: string, args: Record<string, unknown>, c: unknown) => ({ type: "job", id, task, args, contract: c, contract_version: 1 });

export function isResult(id: string) { return (m: any) => (m.type === "result" || m.type === "refuse") && m.id === id; }
