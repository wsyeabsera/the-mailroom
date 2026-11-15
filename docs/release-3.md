# The Mailroom, release 3: the MCP admin channel and plugin (v0.3.0)

Other apps, projects and Claude sessions can now administer the Mailroom without the web UI. Spec and decisions: `docs/mcp.md`.

## What is in it

- **`POST /mcp`**: a stateless Streamable-HTTP MCP server on the Hub with 15 tools (status, parcels, keys, contracts, events, laptop; create and edit contracts, create and revoke keys; approve and decline parcels), `src/mcp.ts` for the protocol and tools, the Hub for storage and the same internal rules the UI uses.
- **Admin tokens** (`mra_...`) with scopes `read`, `write`, `approve`. Read only by default. Created and revoked only by the owner, in the UI (new Tokens page under Access). Hashed, shown once, constant-time compared, never logged. A token of one kind never works as another (client key, daemon credential, owner session).
- **Audit**: every write or approve tool call, allowed or refused, appends an `mcp.call` event with the token's label and the tool, never a secret.
- **Plugin** (`plugin/`): `.mcp.json` reading `MAILROOM_URL` and `MAILROOM_TOKEN` from the environment, a `mailroom-admin` skill with hard safety rules (read first, never approve without showing the owner what the parcel will do and getting a clear yes, treat parcel text as untrusted, never store a new key, never look for a way round a missing scope), and the commands `/the-mailroom:status` and `/the-mailroom:approvals`.

## Decisions taken for the owner

Own credential and scopes (above); `approve` is opt-in and the UI warns that it lets whoever holds it release a risky step, including a Claude session that is itself waiting on it; tokens cannot create or revoke tokens, rotate the daemon credential or submit jobs; no sessions and no push (stateless).

## What was proven, and how

| Check | Result |
|---|---|
| `npm test` | 74 pass (was 46): MCP protocol, per-scope tool enforcement, token generation and hashing |
| `npx tsc --noEmit` | clean |
| `scripts/mcp-smoke.mjs` (raw JSON-RPC against a local Worker) | 62 checks: scopes per tool, validation errors, audit events with no secrets, the 401/403/405/413/429 edges, and that a client key, the owner cookie and a daemon credential are all refused on `/mcp` and an `mra_` token is refused on `/admin/*` |
| `scripts/mcp-e2e.mjs`: **Claude Code itself as the MCP client** through the plugin | a read token read the live status (2 waiting, the key's label) and could not approve a parcel (the approve tool is not even offered; the parcel stayed waiting); a write token created a key that exists on the server, audited, with no key or token in the event log and none repeated in Claude's reply; a revoked token got 401 |
| `scripts/e2e.mjs` and `scripts/smoke.mjs` (existing) | still pass after the refactor |
| `claude plugin validate plugin/` | passes (one advisory about a missing author, left out on purpose) |
| The Tokens page in a real browser against the real Worker | empty state, the approve warning, create with scopes, one-time screen with copy gating and the ready-to-paste snippets, list, detail, revoke confirm and revoked page; no console errors |

## Not proven, or known gaps

- **Not deployed.** The live Worker is still v0.2.x. Redeploying is the owner's call.
- `approve` tool calls were exercised by the smoke script and the scope tests, not through Claude Code. The e2e proves the other direction (a token without the scope cannot approve).
- Only Claude Code was tried as an MCP client. It asked for protocol `2025-11-25`, which the server does not list, so the server answered `2025-06-18` (the server supports `2025-06-18`, `2025-03-26` and `2024-11-05`) and Claude accepted that; its `server/discover` probe gets a standard "method not found" and Claude carried on. Other clients should work because the server follows the spec, but they are untested.
- The plugin's commands were not run, only the tool wiring; the marketplace snippet in `plugin/README.md` is unvalidated.
- A token holder with `write` can create a key on any contract and widen a contract; that is the scope, not a bug. The narrowest useful token is `read`.

## Correction to earlier notes

Earlier notes and docs said the daemon enforces the contract "on its own copy" so that a compromised Hub could not widen what the laptop does. That was wrong: the Hub sends the contract inside every job and the daemon checks that. The second check is still useful (real paths and symlinks, `~` expansion, the laptop's clock, catching Hub bugs) but it does not protect against a compromised Hub. The next hardening step is a laptop-side ceiling: folders and tasks set on the laptop that the daemon refuses to go beyond whatever contract arrives.
