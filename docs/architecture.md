# The Mailroom: architecture (draft, not approved)

Slice 1 only: auth. Claude does not execute anything yet.

```
client (Dunder Miffbot, anything) --HTTPS, API key--> Gateway Worker --> Hub (Durable Object, SQLite)
                                                                            ^
laptop daemon (`mailroom`) --outbound WebSocket, daemon credential----------+
owner browser --session cookie--> admin UI (served by the Worker) -----------+
```

Everything on Cloudflare, deployed with `wrangler deploy`. One Durable Object (the Hub) is the only writer, as in `lite`.

## Parties and credentials

| Party | Proves itself with | Can do |
|---|---|---|
| Client | API key (`mr_...`, shown once, stored as a hash) | submit jobs and read their results, only within its contract |
| Daemon | one daemon credential, separate from client keys | connect out, receive jobs, return results |
| Owner | password session cookie (copied from `lite`) | issue/revoke keys, edit contracts, read the event log, approve risky steps |

A client key never works as a daemon credential or a session, and the reverse.

## Data (Hub SQLite)

- `keys(id, label, hash, contract_id, created_at, revoked_at, last_used_at)`
- `contracts(id, name, body JSON, version, updated_at)`: folders, allowed tasks, daily job/time limit, expiry, which steps need approval
- `jobs(id, key_id, contract_version, task, args JSON, state, created_at, ...)`: state `queued | waiting_approval | running | done | failed | refused | expired`
- `events(seq INTEGER PRIMARY KEY AUTOINCREMENT, kind, payload JSON, ts)`: append-only, same replay (`?after=<seq>`) as `lite`

Nothing is updated in place except job state and revocation; each change also appends an event.

## Job flow (slice 1: echo only)

1. Client POSTs a job with its key. Gateway hashes the key, finds it, rejects if revoked or expired.
2. Gateway checks the job against the contract. Outside it: job is `refused`, event recorded, nothing reaches the laptop.
3. Allowed: job is `queued` (or `waiting_approval` if the contract says so).
4. If the daemon is connected, the Hub pushes the job. If not, it waits; the UI shows "waiting for laptop".
5. The Hub sends the job with its contract; the daemon **checks that contract again on the laptop** before acting (real paths and symlinks, `~` with the laptop's home, the laptop's clock), then runs and returns the result. Hub stores it; client reads it by job id.

The second check catches Hub bugs, stale state and symlink or path tricks the gateway cannot see. The contract arrives in the job message, so on its own it does not make the laptop independent of the Hub. The laptop policy (`~/.mailroom/policy.json`, `{folders, tasks, commands?}`, mode 0600, managed by `mailroom policy`) is that ceiling: `recheck` loads it fresh per job and refuses any job whose contract folders (symlink-safe) or tasks exceed it, or whose commands exceed it when the contract has them. With no policy file the daemon keeps the old behaviour and warns once; a malformed file refuses every job.

## Lanes

Two lanes so a long job does not delay a quick one. `short`: `echo`, `read_file`, `write_file`, and `run` commands the laptop reported with `timeoutMs <= 60000`. `long`: `claude`, every other `run`, anything unknown. The pure rules are in `shared/lanes.ts`. The Hub (`pushNext`) keeps at most one job in flight per lane and picks the oldest queued job of each free lane, so order is strict within a lane. The daemon (`daemon/client.ts`) keeps a queue, an abort controller and progress reporting per running job and cancels by id. The Hub cannot read a laptop's registry, so the daemon reports lane hints in its hello (`lanes.commands`); an unreported command is `long`, the conservative choice. A daemon whose hello has no `lanes` field keeps the old single lane. A lost connection requeues every running job in both lanes, as before. A policy of "short" is a hint for scheduling only; it grants nothing.

## Rules

- Key and credential comparison in constant time; keys never logged; shown once.
- Revocation and contract edits apply to the next job and to queued jobs immediately.
- Daily limits counted in the Hub, not the client.
- Job size and rate limits on the gateway.
- Owner-only routes refuse cross-site `Origin`; the site is gated with `run_worker_first` like `lite`.
- Daemon reconnects with backoff and resumes from the last `seq` it saw.

## Reuse from `lite`

Hub + events table + replay, bearer-token and session code (`src/auth.ts`, `session.ts`, `site-gate.ts`, `login-limit.ts`), `wrangler.jsonc` shape, `node:test` fast loop with pure rule functions. Copy and trim; do not import.

## Open

- Daemon credential rotation.
- Contract schema details (folder patterns, task names).
- Domain and Cloudflare account.
