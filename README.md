# The Mailroom

A small, personal service that lets software in the cloud ask the Claude Code on one laptop to do work, safely. A Cloudflare Worker and one Durable Object are the gateway; a daemon on the Mac dials out to it. API keys are bound to contracts that say what each key may do, and the laptop enforces the contract again itself.

For personal use on the owner's own machine only. It is not a service for other people.

**Status: v0.3.1.** Slice 1 (auth, contracts, keys, events, daemon, admin UI) and slice 2 (approvals, running a Claude Code task) are built, tested locally, and deployed once to the owner's Cloudflare account (workers.dev).

## Parts

| Part | Where | What |
|---|---|---|
| Gateway + Hub | `src/` | Worker and one Durable Object (SQLite): keys, contracts, jobs, events, owner login, daemon socket |
| Contract rules | `shared/contract.ts` | The one pure rule, used by the gateway and the daemon |
| Daemon | `daemon/` | `mailroom login / run / status / logout` on the laptop |
| Admin UI | `ui/` | Plain HTML, CSS and ES modules, dark and light. Served by the Worker behind the owner login |
| Browser extension | `extension/` | Chrome MV3: badge with the approvals waiting, popup, side panel, notifications. See `extension/README.md` |
| MCP admin channel | `src/mcp.ts`, `POST /mcp` | A remote MCP server so other apps and Claude sessions can administer it with their own scoped tokens. See `docs/mcp.md` |
| Claude Code plugin | `plugin/` | One install connects a Claude session to the MCP channel, with a skill of safety rules and two commands. See `plugin/README.md` |
| API | `docs/api.md` | The interface everything is built against |

## Run it locally

```sh
npm install
cp .dev.vars.example .dev.vars        # set OWNER_PASSWORD and SESSION_SECRET
npm run dev                           # http://localhost:8787, sign in with OWNER_PASSWORD
```

In the UI: **Contracts** → New contract, **Keys** → New key (copy it, it is shown once), **Laptop** → Rotate credential (copy it, shown once). Then on the laptop:

```sh
node daemon/cli.ts login --url http://localhost:8787 --credential mrd_...
node daemon/cli.ts run
```

A client then sends work with its key:

```sh
curl -X POST localhost:8787/api/jobs -H "Authorization: Bearer mr_live_..." \
  -H 'content-type: application/json' -d '{"task":"echo","args":{"text":"hello"}}'
```

To keep the laptop connected after a reboot or a closed terminal, run it as a background service (macOS launchd):

```sh
mailroom login                 # prompts for the Hub URL and the daemon credential (hidden)
mailroom service install       # starts at login, restarts if it stops; log: ~/Library/Logs/mailroom-daemon.log
mailroom service status        # installed? running? does the Hub accept the credential?
mailroom service uninstall
```

`mailroom` is a one-line wrapper around `node daemon/cli.ts`; put it on your PATH (for example `~/.local/bin/mailroom`). If the credential is rotated or wrong, the daemon exits and launchd retries once a minute, so run `mailroom login` again and then `mailroom service install`.

Tasks: `echo`, `read_file`, `write_file`, `claude` (runs `claude -p` in a folder the contract allows). Paths must be `~/...` or absolute and inside a contract folder. A task the contract lists under "needs approval" waits on the Approvals page.

## Administering it from other apps (MCP)

In the UI open Access, Tokens, New token. A token is `read` only unless you tick `write` (create and revoke keys, create and edit contracts) or `approve` (release waiting parcels: whoever holds it can approve a risky step without you reading it, so give it sparingly). It is shown once. Then, in any MCP client that speaks Streamable HTTP, for example Claude Code:

```sh
claude mcp add --transport http mailroom https://<your-hub>/mcp --header "Authorization: Bearer mra_..."
```

or install the plugin in `plugin/` (see its README). Tokens are separate from client keys, the daemon credential and your sign-in, and a token of one kind never works as another. Every write is recorded as an `mcp.call` event. Details and the tool list: `docs/mcp.md`.

## Tests

```sh
npm test                  # unit tests (contract rules, keys, sessions, daemon, extension, MCP protocol and tools)
npm run typecheck
node scripts/smoke.mjs    # needs `npm run dev` on 8787, or pass a URL: 59 checks against the Worker
node scripts/mcp-smoke.mjs  # raw JSON-RPC against /mcp: scopes, audit, auth boundaries (needs `npm run dev`; pass a URL)
node scripts/mcp-e2e.mjs  # Claude Code itself as the MCP client, through ./plugin, against its own local Worker
node scripts/e2e.mjs      # starts its own Worker and a real daemon, uses real files, cleans up after itself
node scripts/ui-mock.mjs  # the UI against an in-memory mock on :8799, no Worker needed
PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core node scripts/extension-e2e.mjs   # the extension in a throwaway Chromium (needs a Playwright Chromium; downloads nothing)
```

## Deploying

The owner's copy is already deployed (its URL is not in this public repo). To deploy your own, you need a Cloudflare account (decision d28: personal account, workers.dev subdomain):

```sh
npx wrangler login
npx wrangler secret put OWNER_PASSWORD
npx wrangler secret put SESSION_SECRET
npm run deploy
```

Secrets can only be set once the Worker exists, so run `npm run deploy` first; until the secrets are set, sign-in fails closed (500) and no session is valid. Then `mailroom login --url https://the-mailroom.<you>.workers.dev` on the laptop and set that URL in the extension's options.

## Docs

`docs/ideas.md` (what and why), `docs/architecture.md`, `docs/api.md`, `docs/ui-brief.md`, `docs/release-1.md` (designs), `docs/release-2.md` (the working system), `docs/release-3.md` (MCP channel and plugin), `docs/mcp.md`.
