// Tests the `mailroom` CLI as a user runs it: the installed wrapper, every command, the interactive hidden prompt
// (through a pseudo-terminal), `run`, and the real launchd service, against a local Worker. Uses a throwaway HOME.
// macOS only (launchd). Run: node scripts/cli-e2e.mjs   
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

const PORT = 8805;
const BASE = `http://localhost:${PORT}`;
const root = new URL("..", import.meta.url).pathname;
const pass = readFileSync(join(root, ".dev.vars"), "utf8").match(/^OWNER_PASSWORD=(.*)$/m)[1];
const tmp = mkdtempSync(join(tmpdir(), "mr-cli-"));
const HOME = join(tmp, "home");
mkdirSync(HOME);
const work = join(tmp, "work");
mkdirSync(work);
const procs = [];
let failed = 0;
const ok = (c, m) => { if (c) console.log(`  ok   ${m}`); else { failed++; console.log(`  FAIL ${m}`); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const killGroup = p => { try { process.kill(-p.pid, "SIGKILL"); } catch { try { p.kill("SIGKILL"); } catch {} } };
async function until(fn, ms = 20000) { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(300); } return null; }

// The user's shell, roughly: ~/.local/bin on PATH, HOME overridden to the throwaway one.
// The service test must NEVER touch the real background service (label dev.mailroom.daemon): it gets its own label.
const SERVICE_LABEL = `dev.mailroom.daemon.e2e${process.pid}`;
if (SERVICE_LABEL === "dev.mailroom.daemon") process.exit(2);
const env = { PATH: `${homedir()}/.local/bin:${process.env.PATH}`, HOME, TERM: "xterm", MAILROOM_SERVICE_LABEL: SERVICE_LABEL };
const wrapper = join(homedir(), ".local/bin/mailroom");
const mr = (args, extra = {}) => spawnSync(existsSync(wrapper) ? wrapper : "node", existsSync(wrapper) ? args : [join(root, "daemon/cli.ts"), ...args], { env: { ...env, ...extra }, encoding: "utf8", timeout: 60000 });
const cfgFile = join(HOME, ".mailroom/config.json");

async function cleanup() {
  spawnSync(wrapper, ["service", "uninstall"], { env, stdio: "ignore" });
  for (const p of procs) killGroup(p);
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
}
process.on("exit", () => { for (const p of procs) killGroup(p); });

console.log("starting a local Worker ...");
const w = spawn("npx", ["wrangler", "dev", "--port", String(PORT), "--inspector-port", "9356", "--persist-to", join(tmp, "state")], { cwd: root, stdio: "ignore", detached: true });
procs.push(w);
if (!(await until(async () => { try { return (await fetch(BASE + "/admin/state")).status === 401; } catch { return false; } }, 60000))) { console.log("FAIL the Worker did not start"); process.exit(1); }

let cookie = "";
const owner = async (m, p, b) => { const r = await fetch(BASE + p, { method: m, headers: { cookie, "content-type": "application/json", origin: BASE }, body: b === undefined ? undefined : JSON.stringify(b) }); const t = await r.text(); return { s: r.status, j: t ? JSON.parse(t) : null, h: r.headers }; };
cookie = (await owner("POST", "/admin/login", { password: pass })).h.get("set-cookie").split(";")[0];
const contract = (await owner("POST", "/admin/contracts", { name: "CLI test", folders: [work], tasks: ["echo", "claude"], dailyLimit: 50, expires: null, approval: [] })).j;
const key = (await owner("POST", "/admin/keys", { label: "cli test", contract_id: contract.id })).j.key;
const rotate = async () => (await owner("POST", "/admin/laptop/rotate")).j.credential;
const job = async (task, args) => { const r = await (await fetch(BASE + "/api/jobs", { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ task, args }) })).json(); return until(async () => { const j = await (await fetch(`${BASE}/api/jobs/${r.id}`, { headers: { authorization: `Bearer ${key}` } })).json(); return ["done", "failed", "refused"].includes(j.state) ? j : null; }, 120000); };
const connected = async () => (await owner("GET", "/admin/laptop")).j.connected;

try {
  console.log("the command on your PATH");
  ok(existsSync(wrapper), "~/.local/bin/mailroom exists");
  let r = mr([]);
  ok(r.status === 0 && /login .*\n.*run .*\n.*status/.test(r.stdout) && /service install/.test(r.stdout), "no arguments prints the help, including `service`, exit 0");
  r = mr(["bogus"]);
  ok(r.status === 1, "an unknown command prints the help and exits 1");

  console.log("before login");
  r = mr(["status"]);
  ok(r.status === 1 && /config: no/.test(r.stdout), "status says there is no config, exit 1");
  r = mr(["run"]);
  ok(r.status === 1 && /mailroom login/.test(r.stderr), "run refuses and says to log in, exit 1");
  r = mr(["service", "install"]);
  ok(r.status === 1 && /mailroom login/.test(r.stderr), "service install refuses before login");
  r = mr(["login", "--url", BASE, "--credential", "not-a-credential"]);
  ok(r.status !== 0 && !existsSync(cfgFile), "login refuses a credential that does not start with mrd_ and saves nothing");

  console.log("interactive login (a real pseudo-terminal, hidden input)");
  const cred1 = await rotate();
  const py = `
import os, pty, select, sys, time
env = dict(os.environ)
pid, fd = pty.fork()
if pid == 0:
    os.execvpe(sys.argv[1], [sys.argv[1], "login"], env)
buf = b""; sent_url = sent_cred = False; t0 = time.time()
while time.time() - t0 < 30:
    r, _, _ = select.select([fd], [], [], 0.3)
    if r:
        try: d = os.read(fd, 4096)
        except OSError: break
        if not d: break
        buf += d
    if b"Hub URL" in buf and not sent_url:
        sent_url = True; time.sleep(0.2); os.write(fd, (sys.argv[2] + "\\r").encode())
    if b"Daemon credential" in buf and not sent_cred:
        sent_cred = True; time.sleep(0.2); os.write(fd, (sys.argv[3] + "\\r").encode())
_, status = os.waitpid(pid, 0)
sys.stdout.write(buf.decode("utf8", "replace")); sys.stdout.write("\\n__EXIT__%d" % (os.waitstatus_to_exitcode(status)))
`;
  const pty = spawnSync("python3", ["-c", py, existsSync(wrapper) ? wrapper : "node", BASE, cred1], { env, encoding: "utf8", timeout: 60000 });
  ok(/Hub URL/.test(pty.stdout) && /Daemon credential/.test(pty.stdout), "it asks for the Hub URL, then the credential");
  ok(!pty.stdout.includes(cred1), "the typed credential is NOT echoed to the screen");
  ok(pty.stdout.includes("__EXIT__0") && /Saved to/.test(pty.stdout), "it saves and exits 0");
  ok(existsSync(cfgFile) && JSON.parse(readFileSync(cfgFile, "utf8")).credential === cred1, "the config has the credential and URL");
  ok((statSync(cfgFile).mode & 0o777) === 0o600 && (statSync(join(HOME, ".mailroom")).mode & 0o777) === 0o700, "config is mode 0600 inside a 0700 folder");

  console.log("status");
  r = mr(["status"]);
  ok(r.status === 0 && /hub: accepted/.test(r.stdout) && !r.stdout.includes(cred1), "status says the Hub accepts it and never prints the credential");

  console.log("run");
  const d = spawn(existsSync(wrapper) ? wrapper : "node", existsSync(wrapper) ? ["run"] : [join(root, "daemon/cli.ts"), "run"], { env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  procs.push(d);
  let out = ""; d.stdout.on("data", x => (out += x)); d.stderr.on("data", x => (out += x));
  ok(await until(connected, 20000), "`mailroom run` connects: the Hub shows the laptop connected");
  r = mr(["status"]);
  ok(r.status === 0 && /accepted \(a laptop is connected\)/.test(r.stdout), "status while it runs says accepted and that a laptop is connected");
  await sleep(2500);
  ok(d.exitCode === null && (await connected()), "and `status` did NOT kick the running daemon off (it is still connected)");
  let j = await job("echo", { text: "from the cli" });
  ok(j?.state === "done" && j.result?.echo === "from the cli", "an echo job runs through it");
  const cred2 = await rotate();
  const exited = await until(() => d.exitCode !== null, 15000);
  ok(exited && d.exitCode === 1 && /login/i.test(out), `rotating the credential makes it stop with a clear message (exit ${d.exitCode})`);
  r = mr(["status"]);
  ok(r.status === 1 && /rejected|not accepted|refused/i.test(r.stdout + r.stderr), "status now says the old credential is rejected, exit 1");

  console.log("log in again with a flag, then the background service");
  r = mr(["login", "--url", BASE, "--credential", cred2]);
  ok(r.status === 0, "login with flags works");
  r = mr(["service", "install"]);
  ok(r.status === 0 && /Running \(pid \d+\)/.test(r.stdout), `service install starts it: ${r.stdout.trim().split("\n").pop()}`);
  ok(await until(connected, 20000), "the launchd-run daemon is connected to the Hub");
  r = mr(["service", "status"]);
  ok(r.status === 0 && /running \(pid \d+\)/.test(r.stdout) && /hub: accepted/.test(r.stdout), "service status: running, and the Hub accepts it");
  const svcPid = /pid (\d+)/.exec(r.stdout)?.[1];
  await sleep(2500);
  ok((await connected()) && /pid (\d+)/.exec(mr(["service", "status"]).stdout)?.[1] === svcPid, "service status did not restart or replace the service (same pid, still connected)");
  j = await job("echo", { text: "from the service" });
  ok(j?.state === "done" && j.result?.echo === "from the service", "an echo job runs through the background service");
  // The launchd PATH for the REAL home must find `claude` (a fake HOME here has no Claude login, so it cannot run one).
  const { servicePath } = await import(new URL("../daemon/service.ts", import.meta.url).href);
  const svcPath = servicePath(process.execPath, homedir());
  const found = spawnSync("/bin/sh", ["-c", "command -v claude"], { env: { PATH: svcPath }, encoding: "utf8" });
  ok(found.status === 0 && found.stdout.trim().endsWith("claude"), `with the service PATH for your real home, \`claude\` resolves (${found.stdout.trim()})`);
  const pidBefore = /pid (\d+)/.exec(mr(["service", "status"]).stdout)?.[1];
  r = mr(["service", "install"]);
  ok(r.status === 0 && /pid (\d+)/.exec(r.stdout)?.[1] !== pidBefore, "installing again replaces the running copy (new pid), no duplicate");
  r = mr(["service", "uninstall"]);
  ok(r.status === 0 && /removed/i.test(r.stdout), "service uninstall removes it");
  ok(await until(async () => !(await connected()), 20000), "and the laptop shows away again");
  r = mr(["service", "status"]);
  ok(/not installed, not running/.test(r.stdout), "service status agrees");
  r = mr(["service", "uninstall"]);
  ok(r.status === 0 && /No service/.test(r.stdout), "uninstalling twice is harmless");

  console.log("logout");
  r = mr(["logout"]);
  ok(r.status === 0 && /Logged out/.test(r.stdout) && !existsSync(cfgFile), "logout deletes the config");
  r = mr(["logout"]);
  ok(/Nothing to delete/.test(r.stdout), "logging out twice is harmless");
} finally {
  await cleanup();
}
console.log(failed ? `\nCLI E2E FAILED (${failed})` : "\nCLI E2E PASSED");
process.exit(failed ? 1 : 0);
