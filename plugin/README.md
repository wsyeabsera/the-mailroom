# The Mailroom plugin for Claude Code

Lets a Claude Code session look at your Mailroom (parcels, keys, contracts, the laptop) and handle approvals, through the Hub's MCP endpoint. It adds a skill with safety rules and two commands, `/the-mailroom:status` and `/the-mailroom:approvals` (Claude Code prefixes commands with the plugin name).

## Install in a project

In the project's folder run `mailroom plugin install` (add `--scope user` for every project, or `local` for just you). It adds this repo as a marketplace and installs the plugin with Claude Code's own commands; `mailroom plugin uninstall` removes it. Then do the set-up below.

## Set up

1. In the Mailroom UI open Access, Tokens, New token. Keep it read only unless you need more. `write` lets Claude create and revoke keys and edit contracts. `approve` lets it release waiting parcels: see the security notes. The token (`mra_...`) is shown once.
2. Put two variables in your shell profile (`~/.zshrc`):
   ```sh
   export MAILROOM_URL="https://your-hub.example"   # the Hub origin, no trailing slash
   export MAILROOM_TOKEN="mra_..."                  # your token
   ```
3. Try it: `claude --plugin-dir /path/to/the-mailroom/plugin`, then `/the-mailroom:status`.

Nothing secret is stored in the plugin; `.mcp.json` only reads the two variables.

## Share it

Put the plugin in a marketplace: a repo with `.claude-plugin/marketplace.json` listing `{ "name": "the-mailroom", "source": "./plugin" }`, then `claude plugin marketplace add <repo>` and `claude plugin install the-mailroom`. Each person uses their own Hub and token.

## Security notes

- The token is a password for your Mailroom. Keep it out of git and chat. Revoke it in the UI (Access, Tokens) if it leaks; it stops working on the next request.
- Prefer a read-only token. Give `approve` only to a session you watch: whoever holds it can release a risky step, including a Claude session that is itself waiting on that approval.
- The skill tells Claude to show you a parcel's task, path and size and get a clear yes before approving, but these are instructions to a model, not a lock. The token's scopes are the real limit.
- Parcel text, event text and key labels can come from outsiders. Claude is told to treat them as data, never as orders.
- A new key is shown once, in the reply. Copy it to where it belongs; Claude is told not to store it.
- Every write and approve call is recorded in the Mailroom's events.
