#!/usr/bin/env node
import readline from "node:readline";
import { deleteConfig, configPath, loadConfig, saveConfig } from "./config.ts";
import { probe, run } from "./client.ts";
import { loadPolicy, savePolicy, policyPath, policyClaude } from "./policy.ts";
import { COMMAND_RE, PROMPT_RE, toolNameOk } from "../shared/contract.ts";
import * as service from "./service.ts";
import { purgeLogs, readLog } from "./logs.ts";
import { doctor, explain, fetchFromHub } from "./doctor.ts";
import fs from "node:fs";
import { SCOPES, runPlugin, setupNote } from "./plugin.ts";
import type { Scope } from "./plugin.ts";
import { fileURLToPath } from "node:url";

const HELP = `mailroom <command>
  login [--url URL] [--credential mrd_...]   save the Hub URL and daemon credential (or env MAILROOM_URL / MAILROOM_CREDENTIAL)
  run                                        connect to the Hub and do its jobs
  status                                     show the config and whether the Hub accepts the credential
  policy show|allow-folder <path>|allow-task <task>|allow-command <name>|allow-prompt <name>|allow-claude-tool <tool>|claude-max-turns <n>|logs on|off   the laptop ceiling the daemon never goes beyond (~/.mailroom/policy.json)
  plugin install|uninstall [--scope user|project|local]   add the Claude Code plugin to the project in the current folder (default scope: project)
  plugin install|uninstall [--scope user|project|local]   add the Claude Code plugin to the project in this folder (default: project)
  doctor [--contracts file.json] [--token mra_...]   check commands.json, prompts.json, policy.json and mcp.json (and the Hub's contracts) and print each problem with its fix
  explain <key label> '<job json>' [--contract file.json] [--token mra_...]   say which rule would refuse a job, without running it
  logs <job id>                              print the owner-only debug log of a claude or ask job (reply and turns; kept 7 days; never sent to the Hub)
  logout                                   delete the saved config
  service install|uninstall|restart|status   keep the daemon running in the background (macOS launchd, starts at login)`;

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
      purgeLogs();
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
      if (sub === "restart") {
        if (!service.status(opts).installed) return fail("No service is installed. Run `mailroom service install` first.");
        service.install(opts); // replaces the running copy with a fresh one: it picks up the code on disk
        await new Promise(r => setTimeout(r, 2500));
        const st = service.status(opts);
        console.log(st.running ? `Restarted (pid ${st.pid}). It runs the code on disk now.` : "Restarted, but not running yet. See ~/Library/Logs/mailroom-daemon.log");
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
      return fail("Usage: mailroom service install|uninstall|restart|status");
    }
    case "plugin": {
      const sub = args[0];
      const scope = (flag(args, "scope") ?? "project") as Scope;
      if ((sub !== "install" && sub !== "uninstall") || !SCOPES.includes(scope)) return fail("Usage: mailroom plugin install|uninstall [--scope user|project|local]");
      const bad = runPlugin(sub, scope, process.cwd());
      if (bad) return fail(bad);
      console.log(sub === "install" ? `Installed the-mailroom (scope ${scope}) for ${process.cwd()}.\n${setupNote()}` : "Removed.");
      return 0;
    }
    case "policy": {
      const sub = args[0];
      const cur = loadPolicy();
      if ("error" in cur) return fail(cur.error);
      const p = cur.policy ?? { folders: [], tasks: [] };
      if (sub === "show") {
        console.log(`${policyPath()}: ${cur.policy ? "set" : "not set (the daemon trusts the Hub's contract)"}`);
        console.log(`folders: ${p.folders.join(", ") || "(none)"}`);
        console.log(`tasks: ${p.tasks.join(", ") || "(none)"}`);
        console.log(`commands: ${(p.commands ?? []).join(", ") || "(none)"}`);
        console.log(`prompts: ${(p.prompts ?? []).join(", ") || "(none)"}`);
        const pc = policyClaude(p);
        console.log(`claude tools: ${pc.tools.join(", ")}${p.claudeTools ? "" : " (default)"}`);
        console.log(`claude max turns: ${pc.maxTurns}${p.claudeMaxTurns === undefined ? " (default)" : ""}`);
        console.log(`debug logs: ${p.logs === false ? "off" : "on"}`);
        return 0;
      }
      if (sub === "allow-command" && args[1]) {
        if (!COMMAND_RE.test(args[1])) return fail(`“${args[1]}” is not a command name (letters, numbers, dots, dashes, up to 60).`);
        p.commands = p.commands ?? [];
        if (!p.commands.includes(args[1])) p.commands.push(args[1]);
        savePolicy(p);
        console.log(`Saved ${policyPath()}`);
        return 0;
      }
      if (sub === "allow-prompt" && args[1]) {
        if (!PROMPT_RE.test(args[1])) return fail(`“${args[1]}” is not a prompt name (letters, numbers, dots, dashes, up to 60).`);
        p.prompts = p.prompts ?? [];
        if (!p.prompts.includes(args[1])) p.prompts.push(args[1]);
        savePolicy(p);
        console.log(`Saved ${policyPath()}`);
        return 0;
      }
      if (sub === "allow-claude-tool" && args[1]) {
        if (!toolNameOk(args[1])) return fail(`“${args[1]}” is not a tool name (an MCP tool is mcp__<server>__<tool>, one at a time, no wildcards).`);
        p.claudeTools = p.claudeTools ?? policyClaude(p).tools;
        if (!p.claudeTools.includes(args[1])) p.claudeTools.push(args[1]);
        savePolicy(p);
        console.log(`Saved ${policyPath()}`);
        return 0;
      }
      if (sub === "logs" && (args[1] === "on" || args[1] === "off")) {
        p.logs = args[1] === "on";
        savePolicy(p);
        console.log(`Saved ${policyPath()}`);
        return 0;
      }
      if (sub === "claude-max-turns" && args[1]) {
        const n = Number(args[1]);
        if (!Number.isInteger(n) || n < 1 || n > 50) return fail("claude-max-turns needs a whole number from 1 to 50.");
        p.claudeMaxTurns = n;
        savePolicy(p);
        console.log(`Saved ${policyPath()}`);
        return 0;
      }
      if ((sub === "allow-folder" || sub === "allow-task") && args[1]) {
        const list = sub === "allow-folder" ? p.folders : p.tasks;
        if (!list.includes(args[1])) list.push(args[1]);
        savePolicy(p);
        console.log(`Saved ${policyPath()}`);
        return 0;
      }
      return fail("Usage: mailroom policy show|allow-folder <path>|allow-task <task>|allow-command <name>|allow-prompt <name>|allow-claude-tool <tool>|claude-max-turns <n>|logs on|off");
    }
    case "doctor": {
      let contracts: any[] | null = null;
      const file = flag(args, "contracts");
      const token = flag(args, "token") ?? process.env.MAILROOM_ADMIN_TOKEN;
      try {
        if (file) { const j = JSON.parse(fs.readFileSync(file, "utf8")); contracts = Array.isArray(j) ? j : [j]; }
        else if (token) {
          const cfg = loadConfig();
          if (!cfg) return fail("Not logged in, so the Hub URL is unknown. Run `mailroom login` first, or pass --contracts <file>.");
          contracts = (await fetchFromHub(cfg.url, token)).contracts;
        }
      } catch (e) { return fail(`Could not read the contracts: ${(e as Error).message}`); }
      const found = doctor({ contracts });
      for (const f of found) console.log(`${f.level === "error" ? "ERROR" : f.level === "warn" ? "warn " : "info "} ${f.message}${f.fix ? `\n      fix: ${f.fix}` : ""}`);
      const errors = found.filter(f => f.level === "error").length;
      console.log(errors ? `${errors} problem${errors === 1 ? "" : "s"} found.` : "No problems found.");
      return errors ? 1 : 0;
    }
    case "explain": {
      const [label, jobText] = [args[0], args[1]];
      if (!label || !jobText) return fail("Usage: mailroom explain <key label> '<job json, like {\"task\":\"run\",\"args\":{...}}>' [--contract file.json] [--token mra_...]");
      let job: any;
      try { job = JSON.parse(jobText); } catch { return fail("The job is not valid JSON."); }
      if (!job || typeof job.task !== "string") return fail('The job needs a "task", like {"task":"echo","args":{"text":"hi"}}.');
      let contract: any;
      try {
        const file = flag(args, "contract");
        const token = flag(args, "token") ?? process.env.MAILROOM_ADMIN_TOKEN;
        if (file) contract = JSON.parse(fs.readFileSync(file, "utf8"));
        else if (token) {
          const cfg = loadConfig();
          if (!cfg) return fail("Not logged in, so the Hub URL is unknown. Run `mailroom login` first, or pass --contract <file>.");
          const hub = await fetchFromHub(cfg.url, token);
          const keys = hub.keys.filter(k => k.label === label && !k.revoked_at);
          if (keys.length !== 1) return fail(keys.length ? `${keys.length} keys are labelled “${label}”.` : `No live key is labelled “${label}”.`);
          contract = hub.contracts.find(c => c.id === keys[0].contract.id);
          if (!contract) return fail("That key's contract was not found.");
        } else return fail("explain needs the key's contract: pass --token mra_... (a read-scope admin token, or env MAILROOM_ADMIN_TOKEN) or --contract <file.json>.");
      } catch (e) { return fail(`Could not get the contract: ${(e as Error).message}`); }
      const r = explain(contract, { task: job.task, args: job.args ?? {} });
      for (const l of r.lines) console.log(l);
      return r.refused ? 1 : 0;
    }
    case "logs": {
      if (!args[0]) return fail("Usage: mailroom logs <job id>");
      const r = readLog(args[0]);
      if ("error" in r) return fail(r.error);
      process.stdout.write(r.text);
      return 0;
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
