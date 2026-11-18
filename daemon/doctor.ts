// `mailroom doctor` and `mailroom explain`: check the laptop's setup and say why a job would be refused, without running anything.
// doctor reads commands.json, prompts.json, policy.json (and mcp.json) and, when given them, the Hub's contracts; each problem names the fix command.
// explain runs the same two checks a real job meets: the gateway's contract check, then the daemon's own recheck (contract, policy, registry).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeCeiling, check, type Contract } from "../shared/contract.ts";
import { loadPolicy, exceeds, policyClaude, policyPath, type Policy } from "./policy.ts";
import { loadCommand } from "./commands.ts";
import { loadPrompt } from "./prompts.ts";
import { servicePath } from "./service.ts";
import { loadMcpServers, mcpServerOf, mcpPath } from "./mcp.ts";
import { recheck, type JobMsg } from "./tasks.ts";
import { resolvePathFor } from "./paths.ts";

export type Finding = { level: "error" | "warn" | "info"; message: string; fix?: string };

const dir = (home: string) => path.join(home, ".mailroom");
const readJson = (file: string): { value: unknown } | { missing: true } | { error: string } => {
  let text: string;
  try { text = fs.readFileSync(file, "utf8"); } catch (e: any) { return e?.code === "ENOENT" ? { missing: true } : { error: `cannot read ${file}: ${e?.message}` }; }
  try { return { value: JSON.parse(text) }; } catch { return { error: `${file} is not valid JSON` }; }
};

/** The first executable called `name` on a PATH string, or null. */
export function which(name: string, pathEnv: string): string | null {
  if (name.includes("/")) return isExec(name) ? name : null;
  for (const d of pathEnv.split(":")) {
    if (d && isExec(path.join(d, name))) return path.join(d, name);
  }
  return null;
}
function isExec(p: string): boolean {
  try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; }
}

/** What a script's first line asks for: the interpreter to find. null = no `#!` line (the OS cannot start a text file without one). */
function interpreterOf(script: string): { kind: "none" } | { kind: "binary" } | { kind: "interp"; interp: string } {
  let head: Buffer;
  try {
    const fd = fs.openSync(script, "r");
    try { head = Buffer.alloc(256); const n = fs.readSync(fd, head, 0, 256, 0); head = head.subarray(0, n); } finally { fs.closeSync(fd); }
  } catch { return { kind: "none" }; }
  if (head.subarray(0, 2).toString() !== "#!") return head.includes(0) ? { kind: "binary" } : { kind: "none" };
  const parts = head.toString("utf8").split("\n")[0].slice(2).trim().split(/\s+/);
  // `#!/usr/bin/env node` finds node by PATH, which is exactly what differs under launchd.
  if (path.basename(parts[0]) === "env" && parts[1]) return { kind: "interp", interp: parts[1] === "-S" && parts[2] ? parts[2] : parts[1] };
  return { kind: "interp", interp: parts[0] };
}

export type DoctorInput = { home?: string; contracts?: Contract[] | null; pathEnv?: string };

export function doctor(input: DoctorInput = {}): Finding[] {
  const home = input.home ?? os.homedir();
  const svcPath = input.pathEnv ?? servicePath(process.execPath, home);
  const out: Finding[] = [];
  const add = (level: Finding["level"], message: string, fix?: string) => out.push({ level, message, ...(fix ? { fix } : {}) });

  // ---- file modes ----
  for (const f of ["config.json", "commands.json", "prompts.json", "policy.json", "mcp.json", "sessions.json"]) {
    const p = path.join(dir(home), f);
    try {
      const st = fs.statSync(p);
      if (st.mode & 0o077) add("error", `${p} is readable by others (mode ${(st.mode & 0o777).toString(8)}); the daemon refuses commands.json, prompts.json and mcp.json in that state`, `chmod 600 ${p}`);
    } catch { /* missing is judged below */ }
  }

  // ---- policy ----
  const pol = loadPolicy(home);
  let policy: Policy | null = null;
  if ("error" in pol) add("error", `laptop policy unusable: ${pol.error}; every job is refused`, `fix ${policyPath(home)} or remove it`);
  else if (!pol.policy) add("info", `no policy at ${policyPath(home)}: the daemon trusts whatever contract the Hub sends`, "mailroom policy allow-folder <path>");
  else policy = pol.policy;
  const pc = policy ? policyClaude(policy) : null;

  // ---- commands ----
  const cmdFile = path.join(dir(home), "commands.json");
  const cmdRaw = readJson(cmdFile);
  const commands: string[] = [];
  if ("error" in cmdRaw) add("error", cmdRaw.error);
  else if ("missing" in cmdRaw) add("info", `no ${cmdFile}: the run task has no commands`);
  else if (!cmdRaw.value || typeof cmdRaw.value !== "object" || Array.isArray(cmdRaw.value)) add("error", `${cmdFile} must be an object of command names`);
  else {
    for (const name of Object.keys(cmdRaw.value)) {
      commands.push(name);
      const c = loadCommand(name, home);
      if ("error" in c) { add("error", c.error, `edit ${cmdFile}`); continue; }
      const { script, cwd } = c.command;
      if (!fs.existsSync(script)) { add("error", `command “${name}”: script ${script} does not exist`, `fix the path in ${cmdFile}`); continue; }
      if (!isExec(script)) add("error", `command “${name}”: ${script} is not executable`, `chmod +x ${script}`);
      else {
        const ip = interpreterOf(script);
        if (ip.kind === "none") add("error", `command “${name}”: ${script} has no #! line, so it cannot be started directly`, `add a first line like #!/usr/bin/env node to ${script}`);
        else if (ip.kind === "interp" && !which(ip.interp, svcPath))
          add("error", `command “${name}”: its interpreter “${ip.interp}” is not found on the background service's PATH (${svcPath}); a script that works in your shell fails under launchd`, ip.interp === "node" ? `use #!${process.execPath} in ${script}, or install node into one of those folders` : `use an absolute path to ${ip.interp} in ${script}'s #! line`);
      }
      const real = resolvePathFor(cwd, home);
      if (real === null || !fs.existsSync(real) || !fs.statSync(real).isDirectory()) add("error", `command “${name}”: cwd ${cwd} is not a folder`, `fix the cwd in ${cmdFile}`);
      if (policy) {
        if (!(policy.commands ?? []).includes(name)) add("warn", `command “${name}” is not in the policy, so no contract can use it`, `mailroom policy allow-command ${name}`);
        const pf = policy.folders.map(f => resolvePathFor(f, home));
        if (real !== null && !pf.some(p => p !== null && (real === p || real.startsWith(p === "/" ? "/" : p + "/")))) add("error", `command “${name}”: cwd ${real} is outside the policy folders`, `mailroom policy allow-folder ${real}`);
      }
    }
  }

  // ---- prompts ----
  const prFile = path.join(dir(home), "prompts.json");
  const prRaw = readJson(prFile);
  const prompts: string[] = [];
  const servers = loadMcpServers(home);
  if ("error" in prRaw) add("error", prRaw.error);
  else if ("missing" in prRaw) add("info", `no ${prFile}: the ask task has no prompts`);
  else if (!prRaw.value || typeof prRaw.value !== "object" || Array.isArray(prRaw.value)) add("error", `${prFile} must be an object of prompt names`);
  else {
    for (const name of Object.keys(prRaw.value)) {
      prompts.push(name);
      const p = loadPrompt(name, home);
      if ("error" in p) { add("error", p.error, `edit ${prFile}`); continue; }
      const real = resolvePathFor(p.prompt.cwd, home);
      if (real === null || !fs.existsSync(real) || !fs.statSync(real).isDirectory()) add("error", `prompt “${name}”: cwd ${p.prompt.cwd} is not a folder`, `fix the cwd in ${prFile}`);
      if (policy) {
        if (!(policy.prompts ?? []).includes(name)) add("warn", `prompt “${name}” is not in the policy, so no contract can use it`, `mailroom policy allow-prompt ${name}`);
        const outside = p.prompt.tools.filter(t => !pc!.tools.includes(t));
        if (outside.length === p.prompt.tools.length) add("error", `prompt “${name}”: none of its tools (${p.prompt.tools.join(", ")}) are within the policy, so it can never run`, outside.map(t => `mailroom policy allow-claude-tool '${t}'`).join("; "));
        else if (outside.length) add("warn", `prompt “${name}”: tools ${outside.join(", ")} are outside the policy and will be dropped`, outside.map(t => `mailroom policy allow-claude-tool '${t}'`).join("; "));
        if (p.prompt.maxTurns > pc!.maxTurns) add("warn", `prompt “${name}”: maxTurns ${p.prompt.maxTurns} is above the policy's ${pc!.maxTurns} and will be cut`, `mailroom policy claude-max-turns ${p.prompt.maxTurns}`);
      }
      // MCP tools (see daemon/mcp.ts): the server must be declared on this laptop.
      for (const t of p.prompt.tools) {
        const s = mcpServerOf(t);
        if (s && !servers.servers[s]) add("error", `prompt “${name}”: tool ${t} needs the MCP server “${s}”, which is not declared in ${mcpPath(home)}`, `add "${s}": {"command": "...", "args": [...]} to ${mcpPath(home)}`);
      }
    }
    if (!(prompts.length === 0) && !which("claude", svcPath)) add("warn", `the “claude” program is not on the background service's PATH (${svcPath}); ask jobs would fail under launchd`, `link it into ${path.join(home, ".local/bin")} or /opt/homebrew/bin`);
  }

  // ---- mcp.json ----
  for (const e of servers.problems) add("error", e, `edit ${mcpPath(home)}`);
  for (const [name, s] of Object.entries(servers.servers)) {
    if (!which(s.command, svcPath)) add("error", `MCP server “${name}”: command “${s.command}” is not found on the background service's PATH (${svcPath})`, `use an absolute path in ${mcpPath(home)}`);
  }

  // ---- contracts ----
  if (input.contracts) {
    const usedCmds = new Set<string>(), usedPrompts = new Set<string>();
    for (const c of input.contracts) {
      for (const x of c.commands ?? []) { usedCmds.add(x); if (!commands.includes(x)) add("error", `contract “${c.name}” allows command “${x}”, which is not in ${cmdFile}`, `register “${x}” in commands.json, or remove it from the contract`); }
      for (const x of c.prompts ?? []) { usedPrompts.add(x); if (!prompts.includes(x)) add("error", `contract “${c.name}” allows prompt “${x}”, which is not in ${prFile}`, `register “${x}” in prompts.json, or remove it from the contract`); }
      if (policy) {
        const over = exceeds(policy, c, null, home);
        if (over) add("error", `contract “${c.name}”: ${over.replace(/ To allow(?: it)?: .*$/, "")}`, /To allow(?: it)?: (.*)$/.exec(over)?.[1]);
      }
      if (c.tasks.includes("ask")) {
        const ceil = claudeCeiling(c);
        for (const name of c.prompts ?? []) {
          const p = loadPrompt(name, home);
          if ("prompt" in p && !p.prompt.tools.some(t => ceil.tools.includes(t))) add("error", `contract “${c.name}”: none of prompt “${name}”'s tools (${p.prompt.tools.join(", ")}) are in the contract's claudeTools (${ceil.tools.join(", ")}), so the job fails`, `add a tool to the contract's claudeTools`);
        }
      }
    }
    for (const x of commands) if (!usedCmds.has(x)) add("warn", `command “${x}” is not used by any contract`, `remove it from ${cmdFile}, or allow it in a contract`);
    for (const x of prompts) if (!usedPrompts.has(x)) add("warn", `prompt “${x}” is not used by any contract`, `remove it from ${prFile}, or allow it in a contract`);
  } else add("info", "contracts were not checked: pass --contracts <file.json> (exported contracts) or --token mra_... (a read-scope admin token) to check them against this laptop");
  return out;
}

/** The contracts and keys of a Hub, through its MCP admin channel (read scope is enough). */
export async function fetchFromHub(url: string, token: string): Promise<{ contracts: (Contract & { id: string })[]; keys: { id: string; label: string; contract: { id: string; name: string }; revoked_at: number | null }[] }> {
  let id = 0;
  const tool = async (name: string): Promise<any> => {
    const res = await fetch(`${url.replace(/\/+$/, "")}/mcp`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: {} } }), signal: AbortSignal.timeout(10_000) });
    if (res.status === 401) throw new Error("the Hub did not accept that admin token (it should start with mra_)");
    const j: any = await res.json().catch(() => null);
    const r = j?.result;
    if (!r || r.isError) throw new Error(`the Hub could not answer ${name}`);
    return r.structuredContent && !Array.isArray(r.structuredContent) && "result" in r.structuredContent ? r.structuredContent.result : JSON.parse(r.content[0].text);
  };
  const [contracts, keys] = await Promise.all([tool("mailroom_list_contracts"), tool("mailroom_list_keys")]);
  return { contracts: Array.isArray(contracts) ? contracts : contracts.contracts ?? [], keys: Array.isArray(keys) ? keys : keys.keys ?? [] };
}

/** Which rule refuses this job: the gateway's check, then the daemon's, without running anything. Pure of side effects. */
export function explain(contract: Contract, job: { task: string; args: Record<string, unknown> }, home = os.homedir(), now = Date.now()): { lines: string[]; refused: boolean; stage: "gateway" | "daemon" | null; reason?: string } {
  const lines: string[] = [];
  const g = check(contract, job, { now, usedToday: 0 });
  if (g.verdict === "refuse") {
    lines.push(`gateway (the Hub, contract “${contract.name}”): REFUSED: ${g.reason}`);
    lines.push("the job would be refused at submit (403) and never reach the laptop");
    return { lines, refused: true, stage: "gateway", reason: g.reason };
  }
  lines.push(`gateway (the Hub, contract “${contract.name}”): ${g.verdict === "approve" ? `allowed, but waits for the owner's approval (${job.task} is in the contract's approval list)` : "allowed"}`);
  const d = recheck({ id: "explain", task: job.task, args: job.args, contract } as JobMsg, now, home);
  if ("reason" in d) {
    lines.push(`daemon (this laptop): REFUSED: ${d.reason}`);
    return { lines, refused: true, stage: "daemon", reason: d.reason };
  }
  lines.push(`daemon (this laptop): allowed${d.resolved ? ` (runs in ${d.resolved})` : ""}`);
  lines.push("not checked here: the key's daily limit and Claude budget, the Hub's run-argument pre-check, and whether the script itself succeeds");
  return { lines, refused: false, stage: null };
}
