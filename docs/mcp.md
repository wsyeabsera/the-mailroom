# The Mailroom: MCP admin channel (v0.3)

A remote MCP server on the Hub, so other apps, projects and Claude sessions can administer the Mailroom (look at parcels, manage keys and contracts, handle approvals) without the web UI. It is a third way in, next to client keys (`/api/jobs`) and the owner session (`/admin/*`), and it is deliberately separate from both.

## Decisions (taken for the owner, all reversible)

1. **Own credential: admin tokens `mra_<32 base62>`.** Separate from client keys (`mr_live_`), the daemon credential (`mrd_`) and the owner session. A token of one kind never works as another. Stored as a SHA-256 hash, shown once, revocable, compared in constant time, never logged.
2. **Scopes, least power by default.** `read` (look only), `write` (also create and revoke keys, create and edit contracts), `approve` (also approve or decline waiting parcels). `write` and `approve` each include `read`; `approve` does not include `write` and the reverse. A new token has only `read` unless the owner ticks more. **`approve` is the dangerous one**: whoever holds it can release a risky step without the owner reading it, including a Claude session that is itself asking for the approval. The UI says so.
3. **Only the owner creates tokens, in the UI** (`POST /admin/tokens`, owner session). A token cannot create or revoke tokens, rotate the daemon credential, or sign in as the owner. Job submission stays on the client API.
4. **Every write is audited.** Each successful or failed `write`/`approve` tool call appends an event `mcp.call` `{token_id, label, tool, ok, target?}`. Reads are not logged (noise).
5. **Stateless Streamable HTTP.** No sessions, no server push. Simple and works on a Durable Object.

## Endpoint

`POST {hub}/mcp`, `Authorization: Bearer mra_...`, `Content-Type: application/json`. One JSON-RPC 2.0 message per request (a batch array is rejected with -32600).

- No or unknown or revoked token: HTTP 401 with `WWW-Authenticate: Bearer`.
- An `Origin` header that is not the Hub's own: 403 (DNS-rebinding guard; non-browser clients send none).
- Body over 64 KB: 413. More than 120 requests a minute per token: 429.
- `GET /mcp` and `DELETE /mcp`: 405 (no push, no sessions).
- A request (has `id`) gets `200 application/json` with the JSON-RPC response; a notification (no `id`) gets `202` with no body.

Methods: `initialize` (answer with the client's `protocolVersion` if it is one of `2025-06-18`, `2025-03-26`, `2024-11-05`, else `2025-06-18`; `serverInfo {name:"the-mailroom", version}`; `capabilities {tools:{listChanged:false}}`; short `instructions` text), `notifications/initialized` (202), `ping` (`{}`), `tools/list`, `tools/call`. Anything else: -32601. Bad JSON: -32700. Not a valid request: -32600. Unknown tool or bad arguments shape: -32602. Unexpected failure: -32603.

`tools/call` result: `{content:[{type:"text", text:<JSON string of the data>}], structuredContent:<the data>, isError:false}`. A refused or failed action (missing scope, not found, validation errors, wrong state) is a normal result with `isError:true` and a plain-words message (for validation: the same field messages as the contract editor), not a JSON-RPC error. `tools/list` only lists the tools the token's scopes allow; calling one it does not have is an `isError` result "This token cannot do that (needs the X scope)".

## Tools

All names start with `mailroom_`. `id`s are the Hub's ids (`k_1000`, `c_1000`, `p_1001`). Data shapes are the ones in `docs/api.md`.

| Tool | Scope | Arguments | Returns |
|---|---|---|---|
| `mailroom_status` | read | none | the `GET /admin/state` object (daemon, counts, needs_you, latest_events, approvals) |
| `mailroom_list_parcels` | read | `state?`, `label?` (exact), `limit?` (1-200, default 50) | array of parcels, newest first |
| `mailroom_get_parcel` | read | `id` | parcel + `timeline` + `contract_check` + `key` |
| `mailroom_list_keys` | read | none | keys with their contract (never the secret) |
| `mailroom_get_key` | read | `id` | key + `contract` + `recent_jobs` |
| `mailroom_list_contracts` | read | none | contracts with `used_by` |
| `mailroom_get_contract` | read | `id` | the contract |
| `mailroom_list_projects` | read | none | projects plus a synthetic `unassigned`, each with key_count, running parcel, queued, last run, today's counts |
| `mailroom_get_project` | read | `project` (id or `unassigned`) | the project with its keys, recent parcels and the Commands view (`commands.reported` is false until the laptop reports) |
| `mailroom_events` | read | `after?` (seq), `limit?` (1-500) | `{events, last_seq}` |
| `mailroom_laptop` | read | none | `GET /admin/laptop` object (connected, last_seen, queue, and the laptop's command report with `commands_reported_at`) |
| `mailroom_create_contract` | write | `name, folders[], tasks[], dailyLimit, expires?, approval[]` | the saved contract, or the validation errors |
| `mailroom_update_contract` | write | `id` + the same fields | the saved contract (version bumped; queued parcels are checked again just before they are sent) |
| `mailroom_create_project` | write | `name, folder?, notes?, color?` | the saved project, or the field errors (a project grants nothing) |
| `mailroom_update_project` | write | `project` + any of `name, folder, notes, color` | the saved project (only the fields sent change) |
| `mailroom_create_key` | write | `label, contract_id, project_id?` | `{id, label, key:"mr_live_..."}`: **the only time the key exists in clear**; the tool description tells the model to hand it to the owner, not to paste it elsewhere. `project_id` puts the key in a live project (default Unassigned; an unknown or archived project is refused) |
| `mailroom_revoke_key` | write | `id` | `{id, revoked_at, cancelled}` |
| `mailroom_approve_parcel` | approve | `id` | `{id, state}` (must be `waiting_approval`) |
| `mailroom_decline_parcel` | approve | `id`, `reason?` | `{id, state:"refused"}` |

Projects have no tool for archiving or unarchiving, or for moving an existing key to another project: those are owner-session only (the admin app, `POST /admin/projects/:id/archive`, `PATCH /admin/keys/:id`). A tool can only put a key in a project when it creates the key.

Not exposed on purpose: rotate the daemon credential, anything about admin tokens, owner login, submitting jobs.

## Owner routes for tokens (cookie session, same rules as the other `/admin/*` routes)

- `GET /admin/tokens` -> `[{id, label, prefix, scopes, created_at, last_used_at, revoked_at}]`.
- `POST /admin/tokens {label, scopes}` -> 201 `{id, label, scopes, token:"mra_..."}` (shown once). `label` 1..60 chars; `scopes` a non-empty subset of `read|write|approve` (anything else, or empty, is 422 `{error:"invalid", errors:{...}}`; `read` is added when `write` or `approve` is chosen).
- `POST /admin/tokens/:id/revoke` -> `{id, revoked_at}`; takes effect on the next request.
- Events: `token.created`, `token.revoked` `{token_id, label, scopes}`.
- `admin_tokens(id TEXT PK 't_'+counter, label, prefix, hash, scopes JSON, created_at, revoked_at, last_used_at)` in the Hub SQLite; `last_used_at` is updated at most once a minute.

## Claude Code plugin (`plugin/`)

Bundles the connection and the rules for using it:
- `.mcp.json`: an HTTP server `mailroom` at `${MAILROOM_URL}/mcp` with header `Authorization: Bearer ${MAILROOM_TOKEN}` (environment variables, so no secret is stored in the plugin).
- `skills/mailroom-admin/SKILL.md`: when and how to use the tools, and the safety rules (read first; never approve a parcel without showing the owner what it will do; never print or store a key from `create_key` anywhere but the reply to the owner; widen a contract only with the owner's say-so).
- `commands/`: `/the-mailroom:status`, `/the-mailroom:approvals` (list what waits, with what each will do). Claude Code prefixes a plugin's commands with the plugin name.
- `README.md`: how to create a token in the UI, set the two environment variables, and install (`claude --plugin-dir ./plugin` to try it; add as a marketplace entry to share).

## Where the code lives

`src/mcp.ts` (JSON-RPC dispatch and tool definitions, pure and unit-testable), `src/hub.ts` (token storage, the `/mcp` and `/admin/tokens` routes, calling the same internals the UI routes use), `ui/js/pages/tokens.js` (the Tokens page under Access), `plugin/`, `tests/mcp-*.test.ts`, `scripts/mcp-e2e.mjs`.
