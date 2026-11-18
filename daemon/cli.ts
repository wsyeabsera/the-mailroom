#!/usr/bin/env node
import readline from "node:readline";
import { deleteConfig, configPath, loadConfig, saveConfig } from "./config.ts";
import { probe, run } from "./client.ts";
import { loadPolicy, savePolicy, policyPath } from "./policy.ts";
import * as service from "./service.ts";
import { fileURLToPath } from "node:url";

const HELP = `mailroom <command>
  login [--url URL] [--credential mrd_...]   save the Hub URL and daemon credential (or env MAILROOM_URL / MAILROOM_CREDENTIAL)
  run                                        connect to the Hub and do its jobs
  status                                     show the config and whether the Hub accepts the credential
  policy show|allow-folder <path>|allow-task <task>   the laptop ceiling the daemon never goes beyond (~/.mailroom/policy.json)
  logout                                   delete the saved config
  service install|uninstall|status           keep the daemon running in the background (macOS launchd, starts at login)`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  if (i >= 0) return args[i + 1];
  return args.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
}

function ask(q: string, hidden = false): Promise<string> {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) (rl as any)._writeToOutput = (s: string) => { if (s.includes(q)) process.stdout.write(s); };
    rl.question(q, a => {
      rl.close();
      if (hidden) process.stdout.write("\n");
      resolve(a.trim());
    });
  });
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case "login": {
      const url = flag(args, "url") ?? process.env.MAILROOM_URL ?? (await ask("Hub URL (https://the-mailroom.<sub>.workers.dev): "));
      const credential = flag(args, "credential") ?? process.env.MAILROOM_CREDENTIAL ?? (await ask("Daemon credential (mrd_...): ", true));
      saveConfig({ url, credential });
      console.log(`Saved to ${configPath()}`);
      return 0;
    }
    case "run": {
      const cfg = loadConfig();
      if (!cfg) return fail("Not logged in. Run `mailroom login` first.");
      console.log(`mailroom daemon -> ${cfg.url}`);
      const f = await run(cfg);
      return fail(f.message, f.code === 4002 ? 2 : 1);
    }
    case "status": {
      const cfg = loadConfig();
      console.log(`config: ${cfg ? "yes" : "no"} (${configPath()})`);
      if (!cfg) return 1;
      console.log(`url: ${cfg.url}`);
      const r = await probe(cfg);
      console.log(`hub: ${r}`);
      return r.startsWith("accepted") ? 0 : 1;
    }
    case "service": {
      // MAILROOM_SERVICE_LABEL lets tests (and a second install) use their own launchd label; the default is the real one.
      const label = process.env.MAILROOM_SERVICE_LABEL;
      if (label !== undefined && !/^[A-Za-z0-9.-]{3,100}$/.test(label)) return fail("MAILROOM_SERVICE_LABEL may only contain letters, digits, dots and dashes.");
      const opts = { label, program: [process.execPath, fileURLToPath(new URL("./cli.ts", import.meta.url)), "run"] };
      const sub = args[0];
      if (sub === "install") {
        if (!loadConfig()) return fail("Not logged in. Run `mailroom login` first, then install the service.");
        const file = service.install(opts);
        await new Promise(r => setTimeout(r, 2500));
        const st = service.status(opts);
        console.log(`Installed ${file}`);
        console.log(st.running ? `Running (pid ${st.pid}). It starts at login and restarts if it stops. Log: ~/Library/Logs/mailroom-daemon.log` : "Installed, but not running yet. See ~/Library/Logs/mailroom-daemon.log");
        return st.running ? 0 : 1;
      }
      if (sub === "uninstall") { console.log(service.uninstall(opts) ? "Service removed." : "No service was installed."); return 0; }
      if (sub === "status") {
        const st = service.status(opts);
        console.log(`service: ${st.installed ? "installed" : "not installed"}, ${st.running ? `running (pid ${st.pid})` : "not running"}${st.lastExit ? `, last exit ${st.lastExit}` : ""}`);
        const cfg = loadConfig();
        if (cfg) console.log(`hub: ${await probe(cfg)}`);
        return st.running ? 0 : 1;
      }
      return fail("Usage: mailroom service install|uninstall|status");
    }
    case "policy": {
      const sub = args[0];
      const cur = loadPolicy();
      if ("error" in cur) return fail(cur.error);
      const p = cur.policy ?? { folders: [], tasks: [] };
      if (sub === "show") {
        console.log(`${policyPath()}: ${cur.policy ? "set" : "not set (the daemon trusts the Hub's contract)"}`);
        console.log(JSON.stringify(p, null, 2));
        return 0;
      }
      if ((sub === "allow-folder" || sub === "allow-task") && args[1]) {
        const list = sub === "allow-folder" ? p.folders : p.tasks;
        if (!list.includes(args[1])) list.push(args[1]);
        savePolicy(p);
        console.log(`Saved ${policyPath()}`);
        return 0;
      }
      return fail("Usage: mailroom policy show|allow-folder <path>|allow-task <task>");
    }
    case "logout":
      console.log(deleteConfig() ? "Logged out." : "Nothing to delete.");
      return 0;
    default:
      console.log(HELP);
      return cmd ? 1 : 0;
  }
}

function fail(msg: string, code = 1) {
  console.error(msg);
  return code;
}

main().then(
  c => process.exit(c),
  e => {
    console.error((e as Error).message);
    process.exit(1);
  },
);
