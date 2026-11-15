#!/usr/bin/env node
import readline from "node:readline";
import { deleteConfig, configPath, loadConfig, saveConfig } from "./config.ts";
import { probe, run } from "./client.ts";

const HELP = `mailroom <command>
  login [--url URL] [--credential mrd_...]   save the Hub URL and daemon credential (or env MAILROOM_URL / MAILROOM_CREDENTIAL)
  run                                        connect to the Hub and do its jobs
  status                                     show the config and whether the Hub accepts the credential
  logout                                     delete the saved config`;

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
      return r === "accepted" ? 0 : 1;
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
