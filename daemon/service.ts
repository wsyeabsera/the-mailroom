// `mailroom service install|uninstall|status`: run the daemon in the background on macOS (a launchd user agent),
// so the laptop is connected after a reboot or a closed terminal. The credential stays in ~/.mailroom/config.json
// (mode 0600); the plist holds no secret.
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const LABEL = "dev.mailroom.daemon";

export type ServiceOptions = {
  label?: string;
  program: string[]; // the command launchd runs, e.g. [node, cli.ts, "run"]
  logPath?: string;
  agentsDir?: string; // default ~/Library/LaunchAgents
  home?: string;
  uid?: number;
};

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** launchd gives agents a tiny PATH. The daemon's `claude` task needs the user's bin dirs, so they are listed here. */
export function servicePath(nodeBin: string, home: string): string {
  const dirs = [path.dirname(nodeBin), path.join(home, ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  return [...new Set(dirs)].join(":");
}

export function buildPlist(o: ServiceOptions): string {
  const home = o.home ?? os.homedir();
  const label = o.label ?? LABEL;
  const log = o.logPath ?? path.join(home, "Library/Logs/mailroom-daemon.log");
  const args = o.program.map(a => `    <string>${esc(a)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${esc(label)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${esc(servicePath(o.program[0], home))}</string>
    <key>HOME</key><string>${esc(home)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${esc(log)}</string>
  <key>StandardErrorPath</key><string>${esc(log)}</string>
</dict>
</plist>
`;
}

const uidOf = (o: ServiceOptions) => o.uid ?? os.userInfo().uid;
const plistPath = (o: ServiceOptions) => path.join(o.agentsDir ?? path.join(o.home ?? os.homedir(), "Library/LaunchAgents"), `${o.label ?? LABEL}.plist`);
const domain = (o: ServiceOptions) => `gui/${uidOf(o)}`;
const target = (o: ServiceOptions) => `${domain(o)}/${o.label ?? LABEL}`;

function launchctl(args: string[], allowFail = false): string {
  const r = spawnSync("launchctl", args, { encoding: "utf8" });
  if (r.status !== 0 && !allowFail) throw new Error(`launchctl ${args.join(" ")} failed: ${(r.stderr || r.stdout).trim()}`);
  return (r.stdout ?? "") + (r.stderr ?? "");
}

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const loaded = (o: ServiceOptions) => spawnSync("launchctl", ["print", target(o)], { stdio: "ignore" }).status === 0;

export function install(o: ServiceOptions): string {
  if (process.platform !== "darwin") throw new Error("`mailroom service` supports macOS (launchd) only. Run `mailroom run` under your own supervisor instead.");
  const file = plistPath(o);
  mkdirSync(path.dirname(file), { recursive: true });
  const log = o.logPath ?? path.join(o.home ?? os.homedir(), "Library/Logs/mailroom-daemon.log");
  mkdirSync(path.dirname(log), { recursive: true });
  writeFileSync(file, buildPlist(o), { mode: 0o644 });
  chmodSync(file, 0o644);
  // Replace a running copy. bootout is asynchronous: bootstrapping while the old job is still exiting fails with
  // "Input/output error", so wait until it is gone, and retry the bootstrap briefly if launchd is still settling.
  launchctl(["bootout", target(o)], true);
  for (let i = 0; i < 50 && loaded(o); i++) sleepSync(200);
  for (let attempt = 1; ; attempt++) {
    try { launchctl(["bootstrap", domain(o), file]); break; } catch (e) { if (attempt >= 5) throw e; sleepSync(500); }
  }
  // RunAtLoad starts it. No `kickstart -k`: it kills the fresh job and waits out the restart throttle.
  return file;
}

export function uninstall(o: ServiceOptions): boolean {
  launchctl(["bootout", target(o)], true);
  const file = plistPath(o);
  const had = existsSync(file);
  rmSync(file, { force: true });
  return had;
}

export function status(o: ServiceOptions): { installed: boolean; running: boolean; pid?: number; lastExit?: string } {
  const installed = existsSync(plistPath(o));
  let out = "";
  try { out = execFileSync("launchctl", ["print", target(o)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch { return { installed, running: false }; }
  const pid = /\bpid = (\d+)/.exec(out)?.[1];
  const state = /\bstate = (\w+)/.exec(out)?.[1];
  const lastExit = /last exit code = (\S+)/.exec(out)?.[1];
  return { installed, running: state === "running" && !!pid, pid: pid ? Number(pid) : undefined, lastExit };
}
