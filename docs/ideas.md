# The Mailroom: ideas (draft, nothing approved yet)

Status: brainstorming. No code. Open questions are marked **?**.

## What it is

A small independent service that lets software in the cloud ask the Claude Code on Yab's laptop to do work, safely.

- **Cloud half:** a Cloudflare Worker (gateway) with one Durable Object (SQLite). Clients call it with API keys.
- **Laptop half:** a daemon on the Mac that dials *out* to the gateway and holds the connection open. Cloudflare cannot reach a laptop inbound, so outbound is the only way.
- **Clients:** Dunder Miffbot is the first customer. Anything else built later can be another.

It is its own project, not part of Dunder Miffbot or `lite`.

## Why

- Cloud employees (Dunder Miffbot) run on free Workers AI models, which are weak. Local Claude is strong and already paid for through the subscription.
- Doers need to touch local repos and files. A Worker cannot.
- The only thing between the internet and the laptop is this service, so keys and permissions are the whole point.

## Auth first (slice 1)

Auth is the first thing built, before Claude executes anything.

- Issue an API key, shown once, stored only as a hash.
- Each key is bound to a **contract** (see below).
- The daemon authenticates to the gateway when it connects out.
- A test job (an echo, no Claude) goes client -> gateway -> daemon -> back.
- Use it for a while before slice 2.

## Contracts (**? confirm meaning**)

Working reading: a contract is what a key may do.

- allowed folders on the laptop
- allowed tasks or tools
- daily limit on jobs or running time
- expiry date
- which risky steps need Yab's approval

Revoking a key or editing a contract takes effect immediately. The daemon enforces the contract on the Mac as well, so a compromised gateway cannot widen it.

## Rules (decided in conversation)

- The laptop being offline is a normal state: jobs wait, the UI says "waiting for laptop".
- Jobs are asynchronous and recorded in an append-only event log (same shape as `lite`).
- For personal use on Yab's own machine only. It must not become a service other people use through Yab's subscription.
- The daemon runs only what a valid contract allows, in allowlisted folders.

## Slices (each used before the next starts)

1. Auth: keys, contracts, daemon handshake, echo job.
2. Run a Claude Code task from the laptop under a contract.
3. Approvals for risky steps, from a small UI.
4. More clients.

## Reuse from `lite` (to copy patterns, not rebuild blindly)

- Worker + one Durable Object (SQLite) as the only writer; `wrangler.jsonc` setup.
- Append-only events table; clients reconnect with `?after=<seq>` and replay.
- Bearer token compared in constant time; password session cookie (HMAC, no server state); site gate with `run_worker_first`.
- `node:test` fast loop, pure functions for rules, `ship:local` style gate.
- Source: `~/Hobby/lite/docs/ARCHITECTURE.md`, `docs/auth.md`.

## Open questions

- **?** Contracts: is the reading above right?
- **?** Name of the daemon and CLI (suggestion: `mailroom`).
- **?** Where does Yab approve risky steps: the UI, or a prompt in the terminal?
- **?** Which Cloudflare account and domain does it deploy to?
