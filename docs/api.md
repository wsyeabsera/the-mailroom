# The Mailroom: API (v0.2)

One Worker, one Hub Durable Object (SQLite). Everything below is JSON over HTTPS unless noted. Rules that decide behaviour live in `shared/contract.ts` (read it first). Parties: `docs/architecture.md`.

## Credentials

| Who | Proves itself with | Format |
|---|---|---|
| Client | `Authorization: Bearer mr_live_<32 base62>` | only a SHA-256 hash is stored, compared in constant time |
| Daemon | `Authorization: Bearer mrd_<32 base62>` on the WebSocket upgrade | one credential, hash stored, separate from client keys |
| Owner | cookie `mr_session` (HMAC-SHA256 over `{exp}` with `SESSION_SECRET`, 7 days, HttpOnly, Secure unless localhost, SameSite=Strict) | password = `OWNER_PASSWORD` |

A client key is never a daemon credential or a session, and the reverse. Owner routes (`/admin/*`) refuse a POST, PUT or DELETE whose `Origin` header is present and is not the Worker's own origin (403 `{error:"bad_origin"}`); GET is read-only and is not checked, so the browser extension (origin `chrome-extension://...`) can read `/admin/state` and `/admin/events` with the owner's cookie. Login: 5 wrong passwords per 15 minutes (per IP) returns 429 with `retry_after` seconds.

## Data (Hub SQLite)

- `keys(id TEXT PK, label, prefix, hash, contract_id, created_at, revoked_at, last_used_at)`: `prefix` = first 12 chars of the key (for display, e.g. `mr_live_9aKd`).
- `contracts(id TEXT PK, name, body JSON, version INT, updated_at)`: `body` is a `Contract` (shared/contract.ts).
- `jobs(id TEXT PK 'p_'+4..8 base36 counter-based, key_id, contract_id, contract_version, task, args JSON, state, reason, result JSON, created_at, updated_at)`: state is `queued | waiting_approval | running | done | failed | refused | expired | cancelled` (`expired` is reserved: the Hub does not set it today; an expired contract refuses the parcel at the gateway instead).
- `events(seq INTEGER PRIMARY KEY AUTOINCREMENT, ts, kind, payload JSON)`: append-only. Every state change appends one.
- `daemon(id INTEGER PK CHECK(id=1), hash, rotated_at, last_seen, connected)`: at most one row.
- Event kinds: `key.created`, `key.revoked`, `contract.saved`, `job.queued`, `job.waiting_approval`, `job.refused`, `job.approved`, `job.declined`, `job.running`, `job.done`, `job.failed`, `job.cancelled`, `daemon.connected`, `daemon.disconnected`, `daemon.rotated`, `token.created`, `token.revoked`, `mcp.call`.

Nothing is updated in place except job state, key revocation and `daemon`; each such change also appends an event. The Hub is the only writer.

## Client routes (Bearer client key)

`POST /api/jobs` body `{ "task": "echo|read_file|write_file|claude|run", "args": {...} }`
- 401 `{error:"bad_key"}` if the key is unknown, revoked, or its contract is expired.
- Body over 256 KB: 413. More than 60 requests a minute per key: 429.
- Runs `check()` with `usedToday` = this key's jobs created since 00:00 UTC that are not refused.
- `refuse` -> 403 `{id, state:"refused", reason}` (a job row + `job.refused` event are still written; nothing reaches the laptop).
- `allow` -> 202 `{id, state:"queued"}`; `approve` -> 202 `{id, state:"waiting_approval"}`.
- If the daemon is connected and the job is `queued`, push it (see daemon protocol).

`GET /api/jobs/:id` -> `{id, state, reason?, result?, progress?, created_at, updated_at}` (`progress` is `{text, pct?, at}`, the latest report from a running job) only for jobs of that key, else 404.

## Owner routes (cookie session; 401 `{error:"signed_out"}` without one)

- Admin tokens for the MCP channel (`mra_...`, scopes `read|write|approve`): `GET /admin/tokens`, `POST /admin/tokens {label, scopes}` (the token is returned once), `POST /admin/tokens/:id/revoke`. The channel itself is `POST /mcp`; both are specified in `docs/mcp.md`. Events: `token.created`, `token.revoked`, and `mcp.call` for every write or approve tool call.

- `POST /admin/login {password}` -> 204 + `Set-Cookie`, or 401 `{error:"bad_password", tries_left}`, or 429.
- `POST /admin/logout` -> 204.
- `GET /admin/state` -> `{ daemon:{connected,last_seen,last_seq}, counts:{queued,waiting_approval,running,done,refused,failed} (queued, waiting_approval and running are current; done, refused, failed and the other finished states count only jobs finished since 00:00 UTC), needs_you:[Job + key:{id,label}], latest_events:[Event] (5), approvals:N }`.
- Keys: `GET /admin/keys` -> `[{id,label,prefix,contract:{id,name},created_at,last_used_at,revoked_at}]`; `POST /admin/keys {label, contract_id}` -> 201 `{id, label, key:"mr_live_..."}` (the full key appears only in this response; label 1..60 chars else 422 `{errors:{label}}`; unknown contract 422); `GET /admin/keys/:id` -> key + `recent_jobs` (10) + `contract`; `POST /admin/keys/:id/revoke` -> `{id, revoked_at, cancelled:N}` (queued and waiting jobs of that key become `cancelled`).
- Contracts: `GET /admin/contracts` -> `[{id, ...Contract, version, used_by:N}]`; `POST /admin/contracts` body = Contract -> 201, or 422 `{errors:{field:message}}` from `validateContract`; `PUT /admin/contracts/:id` same, bumps `version` (applies to the next job, and queued jobs are checked again just before they are sent); `GET /admin/contracts/:id`.
- Jobs: `GET /admin/jobs?state=&limit=` -> `[Job]` newest first (default 50); `GET /admin/jobs/:id` -> Job + `timeline:[Event]` + `contract_check:{verdict,reason?}` (re-run now) + `key:{id,label}`.
  `POST /admin/jobs/:id/approve` (state must be `waiting_approval`, else 409) -> `queued` and pushed if the daemon is connected; `POST /admin/jobs/:id/decline` -> `refused` with reason `declined by owner`.
- Events: `GET /admin/events?after=<seq>&limit=&tail=1` (`tail=1` returns the last `limit` events after `after`, oldest first, for a page's first load; without it you get the first `limit`, for replay) -> `{events:[...], last_seq}`; `GET /admin/events/stream?after=<seq>` -> Server-Sent Events, one `data: <Event JSON>` per event with `id: <seq>`, replaying everything after `after` first, then live; a `: ping` comment every 20 s.
- Laptop: `GET /admin/laptop` -> `{connected, last_seen, last_seq, rotated_at, credential_hint:"mrd_...9a3f"|null, queue:[Job] (state queued)}`; `POST /admin/laptop/rotate` -> `{credential:"mrd_..."}` (the only time it is shown; the old one dies at once and the live socket is closed with code 4001).

## Daemon protocol: `GET /daemon` (WebSocket upgrade, Bearer `mrd_...`)

Bad or missing credential: 401, no upgrade. One live daemon at a time: a new valid connection replaces the old (old gets close code 4002). Messages are JSON text frames.

Daemon -> Hub:
- `{type:"hello", version:"0.2.0", last_seq:N}` first. Hub marks the daemon connected, appends `daemon.connected`, replies `{type:"welcome", server_seq:N}`, then pushes every `queued` job in created order (one at a time, next after the previous result).
- `{type:"result", id, ok:true, result:<any JSON>}` -> job `done`. `{type:"result", id, ok:false, error:"..."}` -> job `failed` with `reason`. `{type:"refuse", id, reason}` -> job `refused` (the daemon's own contract re-check said no).
- `{type:"progress", id, text, pct?}` (daemon to Hub) -> stored as the latest progress of the job. `text` is capped at 500 chars, `pct` is clamped to 0..100. Accepted only for the job currently running on that daemon (anything else is ignored), cleared if the job is requeued, and returned as `progress` by the gateway and the admin job views. The daemon sends at most 2 per second. A `run` script reports by printing `MAILROOM_PROGRESS [<pct> ]<text>` lines on stderr (parsed by `daemon/progress.ts`); the `claude` task reports nothing.
- `{type:"pong"}` for each `{type:"ping"}` (Hub pings every 25 s; no pong in 60 s -> treated as disconnected).

Hub -> Daemon:
- `{type:"job", id, task, args, contract:<Contract>, contract_version:N}` (job becomes `running`, event `job.running`).
- `{type:"cancel", id}` when a running or queued job is cancelled by revoke.

On close the Hub appends `daemon.disconnected`; `running` jobs of that daemon go back to `queued`. The daemon reconnects with backoff 1s -> 30s and runs jobs in order.

The daemon must re-run `check()` (with `home` set and paths `realpath`-resolved) before acting and refuse if it fails. Slice 1 tasks: `echo {text}` -> `{echo:text}`; `read_file {path}` -> `{content}` (max 200 KB); `write_file {path, content}` -> `{bytes}`. Slice 2: `claude {prompt, cwd}` -> `{output}` via `claude -p` in `cwd` with a 5 minute timeout. Optional args: `allowedTools` (array of 1-20 strings matching `^[\w:*() .\-]{1,100}$`, passed as `--allowedTools`), `maxTurns` (integer 1-50, `--max-turns`), `model` (string matching `^[\w.\-\[\]]{1,60}$`, `--model`), `json` (boolean; runs `--output-format json` and returns the parsed JSON as `output`). Invalid values fail the job. No shell is involved; all are argv entries. Slice 3: `run {command, args}` -> `{output, exitCode}`. The contract lists `commands: string[]` (names, `/^[\w.-]{1,60}$/`, non-empty when `run` is a task; a stored contract without it means none) and `check()` refuses a `command` not in it. The laptop's `~/.mailroom/commands.json` (mode 0600, read per job) maps each name to `{script (absolute), args: {name: {type: string|number|boolean|enum, required, maxLength, values}}, timeoutMs (default 5 min), cwd}`; the daemon refuses unknown commands, bad args, or a cwd that resolves outside the contract folders, and spawns `script --name value ...` as an argv array with no shell.

## Event shape

`{seq, ts (epoch ms), kind, payload}`. Payloads: job events carry `{job_id, key_id?, task?, reason?}`; key events `{key_id, label}`; contract events `{contract_id, name, version}`; daemon events `{}`.

## Errors

Always `{error:"<code>", message?}` with the status above. 404 `{error:"not_found"}`, 405, 409 `{error:"conflict"}`, 422 `{error:"invalid", errors:{...}}`.

## Admin UI

Static files in `ui/`, served by the Worker (assets binding, `run_worker_first`). Unauthenticated requests get `ui/login.html` only; everything else needs a session. The UI is plain HTML, CSS and ES modules with no build step, dark and light themes (design: Lite project `the-mailroom`, canvases `v2` and `v2-light`; tokens in `docs/release-1.md`).
