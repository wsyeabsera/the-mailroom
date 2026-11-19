# Local MCP servers through the Mailroom

A client in the cloud (for example the cf-os chat Worker) can use the owner's local stdio MCP servers by sending `mcp_list` and `mcp_call` jobs. The Hub knows only a server's name and the tool names the key may use. The command, args, env and working folder live on the laptop. The cloud can never choose what runs.

## 1. Define the server on the laptop

`~/.mailroom/local-mcp.json` (mode 0600, read fresh for every job, so an edit applies to the next job and replaces a running server):

```json
{
  "notes": {
    "command": "/opt/homebrew/bin/node",
    "args": ["/Users/me/mcp/notes-server.js"],
    "env": { "NOTES_TOKEN": "..." },
    "cwd": "/Users/me/mcp",
    "idleSeconds": 120,
    "callTimeoutSeconds": 30
  }
}
```

| Field | Meaning |
|---|---|
| `command`, `args` | What to start. Argv, never a shell. |
| `env` | The only environment the server gets besides `PATH`, `HOME`, `LANG`, `TMPDIR`, `USER`, `SHELL`. The daemon's own environment (tokens, keys) is never passed on. Secrets live here, not in `mcp.json`. |
| `cwd` | Optional absolute working folder. |
| `idleSeconds` | Kill the server after this long unused (1 to 3600, default 120). It starts again on the next job. |
| `callTimeoutSeconds` | Per-call limit (1 to 300, default 30). A call that times out also stops the server, because its state is unknown. |

Other keys, a loose file mode or a bad value make that server undefined, and the job is refused with the reason. This file is separate from `~/.mailroom/mcp.json`, which lists servers handed to `claude` jobs and allows no env.

Also allow the tasks in the laptop policy: `mailroom policy allow-task mcp_list` and `mailroom policy allow-task mcp_call`.

## 2. Allow it in a contract

```json
{
  "tasks": ["mcp_list", "mcp_call"],
  "localMcp": [
    { "server": "notes", "tools": [
      { "name": "search", "approval": false },
      { "name": "append" },
      { "name": "wipe", "approval": true }
    ] }
  ]
}
```

- `server` is a name from `local-mcp.json` (letters, digits, dashes, up to 40). `tools` is the allow-list (1 to 50 names, ASCII letters, digits, `_ . -`; a plain string is shorthand for `{ "name": ... }`). At most 10 servers.
- Names match by exact, case-sensitive equality. No wildcards, trimming, case folding or Unicode normalisation: `Search`, `search ` and a fullwidth `ｓearch` are different names and are refused.
- A server entry or tool entry with any other key (`command`, `args`, `env`, `cwd`) is rejected when the contract is saved.
- `approval`: missing or `true` means the job waits for the owner (the normal Approvals flow). `false` means it does not wait, and the daemon honours that only when the server itself marks the tool `readOnlyHint: true`; for any other tool the call fails with a message, so a mis-marked contract cannot run a write tool unattended. The contract's task-level `approval` list still applies on top.
- `mcp_list` or `mcp_call` in `tasks` needs a non-empty `localMcp`.

## 3. The two tasks

- `mcp_list {server?}` returns `{servers:[{server, tools:[{name, description, readOnly, inputSchema, requiresApproval}]}]}`, only for tools in the contract that the server really offers. A server that cannot start shows as `{server, error}` instead of failing the job.
- `mcp_call {server, tool, args?}` returns `{server, tool, isError, content, structuredContent?, truncated?}`. `args` is an object up to 64 KB. Output is cut at 256 KB (`truncated: true`). A tool that reports `isError` is a normal result, not a failed job.

Servers start on first use, speak JSON-RPC over stdio, restart after a crash with backoff (0.5 s doubling to 30 s; a call inside the window fails fast), and stop when idle or when the daemon exits.

## Threat model

The cloud can ask: list or call a named tool, of a named server, that the key's contract lists, with JSON arguments, and (when the tool is not marked `approval:false` and readOnly) only after the owner approves.

The cloud cannot ask: to start any command, pass argv, env, cwd or timeouts (job keys other than `server`, `tool`, `args` are refused by the Hub and again by the daemon); to reach a server or tool outside the contract; to see a tool the contract does not list; to bypass the contract through name tricks (case, whitespace, Unicode lookalikes, `__proto__`); or to read the daemon's environment.

Still true, and worth knowing:

- The Hub is trusted for what a contract says (as for every task); the laptop's `local-mcp.json` and policy are the ceiling the Hub cannot raise.
- A listed tool does what the server does with the arguments the client sends. Allow-list narrowly, keep write tools on approval, and treat results as untrusted data (they can carry prompt injection).
- `readOnlyHint` is the server's own claim. Only `approval:false` relies on it, and only the owner writes that.
- A server runs with the owner's permissions and the env listed for it. Put only what it needs in `env`.
