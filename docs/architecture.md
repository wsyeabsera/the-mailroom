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
5. Daemon **re-checks the contract copy it holds** before acting, then runs and returns the result. Hub stores it; client reads it by job id.

The daemon enforcing the contract itself means a compromised gateway cannot widen what the laptop will do.

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
