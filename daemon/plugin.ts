import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.ts";

export const MARKETPLACE = "the-mailroom";
export const SCOPES = ["user", "project", "local"] as const;
export type Scope = (typeof SCOPES)[number];

/** The repo root that holds .claude-plugin/marketplace.json (this file lives in <root>/daemon). */
export const repoRoot = () => fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");

/** The `claude plugin ...` calls that install or remove the plugin. Argv arrays: no shell. */
export function pluginCommands(action: "install" | "uninstall", scope: Scope, root = repoRoot()): string[][] {
  const id = `${MARKETPLACE}@${MARKETPLACE}`;
  return action === "install"
    ? [["plugin", "marketplace", "add", root, "--scope", scope], ["plugin", "install", id, "--scope", scope]]
    : [["plugin", "uninstall", id, "--scope", scope]];
}

/** Runs them in `cwd` (the project, for scope project/local). Returns an error message, or null on success. */
export function runPlugin(action: "install" | "uninstall", scope: Scope, cwd: string): string | null {
  for (const argv of pluginCommands(action, scope)) {
    try {
      execFileSync("claude", argv, { cwd, stdio: "inherit" });
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      return code === "ENOENT" ? "Claude Code (`claude`) is not on PATH." : `\`claude ${argv.slice(0, 3).join(" ")}\` failed.`;
    }
  }
  return null;
}

/** What the user still has to do: the plugin never stores the token. */
export function setupNote(): string {
  const url = loadConfig()?.url ?? "https://<your-hub>";
  return [
    "Next: the plugin reads two environment variables (it stores no secret):",
    `  export MAILROOM_URL="${url}"`,
    `  export MAILROOM_TOKEN="mra_..."   # Access > Tokens > New token in the Mailroom UI (read only is enough to start)`,
    "Then restart Claude Code in the project and try /the-mailroom:status.",
  ].join("\n");
}
