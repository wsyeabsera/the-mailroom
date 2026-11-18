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
- `jobs(id TEXT PK 'p_'+4..8 base36 counter-based, key_id, contract_id, contract_version, task, args JSON, state, reason, result JSON, created_at, updated_at, label TEXT NULL)`: `label` is the client's optional tag (see below); `result` holds a result up to 200 KB, a bigger one is in `job_results` and `result` holds the marker `{"$stored":{"bytes":N}}`. State is `queued | waiting_approval | running | done | failed | refused | expired | cancelled` (`expired` is reserved: the Hub does not set it today; an expired contract refuses the parcel at the gateway instead).
- `job_results(job_id TEXT PK, body JSON, bytes, stored_at)`: results over 200 KB (up to 2 MB), kept 7 days, see "Big results" below.
- `idempotency(key_id, idem_key, job_id, fp, created_at, PK(key_id, idem_key))`: the `Idempotency-Key` of a submit, for 24 hours.
- `daemon_rerun(name PK)`: the commands the laptop flagged re-run-safe in its last hello.
- `events(seq INTEGER PRIMARY KEY AUTOINCREMENT, ts, kind, payload JSON)`: append-only. Every state change appends one.
- `daemon(id INTEGER PK CHECK(id=1), hash, rotated_at, last_seen, connected)`: at most one row.
- Event kinds: `key.created`, `key.revoked`, `contract.saved`, `job.queued`, `job.waiting_approval`, `job.refused`, `job.approved`, `job.declined`, `job.running`, `job.done`, `job.failed`, `job.cancelled`, `daemon.connected`, `daemon.disconnected`, `daemon.rotated`, `token.created`, `token.revoked`, `mcp.call`, `callback.failed`, `push.failed`.

Nothing is updated in place except job state, key revocation and `daemon`; each such change also appends an event. The Hub is the only writer.

## Client routes (Bearer client key)

`POST /api/jobs` body `{ "task": "echo|read_file|write_file|claude|run", "args": {...}, "label"?: "test", "callback_url"?: "https://..." }` (`callback_url` rules: see "Callbacks and phone push")
- 401 `{error:"bad_key"}` if the key is unknown, revoked, or its contract is expired.
- Body over 256 KB: 413. More than 60 requests a minute per key: 429.
- Runs `check()` with `usedToday` = this key's jobs created since 00:00 UTC that are not refused or cancelled (a cancelled parcel gives its place back).
- For a `run` job whose command the laptop has reported (with its arg specs), the args are also checked here with the same rules and messages as the daemon (`shared/args.ts`); a bad one is a `refuse`. A command not reported yet is left to the laptop, which always re-checks.
- `refuse` -> 403 `{id, state:"refused", reason}` (a job row + `job.refused` event are still written; nothing reaches the laptop).
- `allow` -> 202 `{id, state:"queued"}`; `approve` -> 202 `{id, state:"waiting_approval"}`.
- If the daemon is connected and the job is `queued`, push it (see daemon protocol).

`GET /api/jobs/:id` -> `{id, state, label?, reason?, result?, progress?, created_at, updated_at}` (`progress` is `{text, pct?, at}`, the latest report from a running job) only for jobs of that key, else 404.

`POST /api/jobs/:id/cancel` (same Bearer key, no body) cancels one of that key's own jobs; another key's job is 404. A `queued` or `waiting_approval` job is dropped; a `running` job is cancelled and the Hub sends `{type:"cancel", id}` to the daemon, which kills the whole child process tree. Either way the job ends as `cancelled` with reason `cancelled by client`, the event `job.cancelled` is appended, and the response is `{id, state:"cancelled"}`. A job already `done`, `failed`, `refused`, `expired` or `cancelled` -> 409 `{error:"not_cancellable", state}`. A result the daemon sends after the cancel is ignored. Cancelled jobs do not count toward the daily limit.

Timeouts: a job that outruns its time limit ends `failed` with reason `timed out after Ns` (distinct from `cancelled`). `claude` has a 5 minute limit (the daemon's `MAILROOM_CLAUDE_TIMEOUT_MS` overrides it). Revoking a key also cancels its running jobs (see below).

## Callbacks and phone push (#2775, #2779)

Decisions made on the owner's behalf; change them if you disagree.

**Callback.** `POST /api/jobs` may include `callback_url`. The contract carries `callbackUrls: string[]` (https prefixes ending in `/`, validated in `shared/contract.ts` via `shared/callback.ts`; missing = none; the contract editor has a field for it, and so does the MCP contract schema). A `callback_url` is accepted only if all of this holds, else 422 `{error:"invalid", errors:{callback_url}}` and no job is created: the Hub has the Worker secret `CALLBACK_SECRET` (unset = every `callback_url` is refused with a message saying so, so nothing is silently dropped); the URL is https, has no user name or password, and its host is not an IP literal (IPv4 or IPv6, so no private or link-local ranges), `localhost`, a `.local`/`.internal`/`.lan`-style name or a name without a dot; the normalised URL starts with one of the contract's prefixes (so `https://good.com.evil.net/` and `../` do not match `https://good.com/`). DNS is not resolved, so a public name that points at a private address is not caught here (Workers cannot reach private networks anyway). Redirects are never followed.

When the job reaches `done`, `failed`, `refused` or `cancelled` (not a refusal at submit, whose 403 already tells the client), the Hub POSTs JSON `{id, state, result}` (done) or `{id, state, reason}` (others) with `X-Mailroom-Signature: sha256=<hex HMAC-SHA256 of the exact body bytes, key CALLBACK_SECRET>`. A result over 8 KB is not sent: the body is `{id, state:"done", result_truncated:true, link:"<hub>/api/jobs/<id>"}` and the client fetches it with its key. Success is any 2xx. Otherwise 3 attempts in all (waits 1 s then 4 s, 5 s timeout each), then an event `callback.failed {job_id, attempts, error}` (the error never contains the URL or the secret). A failed callback never changes the job. Retries live in the Durable Object's memory, so a Hub restart mid-retry drops the rest (the client can still poll `GET /api/jobs/:id`).

Test-only: setting `MAILROOM_ALLOW_LOCAL_URLS=1` lets callback and push URLs be http and local. `scripts/e2e.mjs` sets it with `wrangler dev --var MAILROOM_ALLOW_LOCAL_URLS:1 CALLBACK_SECRET:... PUSH_URL:...` and starts its own local listener; never set it in production.

**Phone push.** When a job enters `waiting_approval` (at submit), if the Worker secret `PUSH_URL` is set (a ntfy-compatible https topic URL, set with `wrangler secret put PUSH_URL`; the topic is the secret), the Hub POSTs plain text to it once per job with headers `Title: Mailroom: <task> needs approval`, `Click: <hub>/#/approvals`, `Tags: inbox_tray` and a body `<task> from <key label>. Open <hub>/#/approvals`. Never args or file content. Unset = nothing. A failure is an event `push.failed {job_id, error}` and never blocks the job. No push service account is created or contacted by the code; the owner picks the service. The Laptop page explains how to set `PUSH_URL`.

## Owner routes (cookie session; 401 `{error:"signed_out"}` without one)

- Admin tokens for the MCP channel (`mra_...`, scopes `read|write|approve`): `GET /admin/tokens`, `POST /admin/tokens {label, scopes}` (the token is returned once), `POST /admin/tokens/:id/revoke`. The channel itself is `POST /mcp`; both are specified in `docs/mcp.md`. Events: `token.created`, `token.revoked`, and `mcp.call` for every write or approve tool call.

- `POST /admin/login {password}` -> 204 + `Set-Cookie`, or 401 `{error:"bad_password", tries_left}`, or 429.
- `POST /admin/logout` -> 204.
- `GET /admin/state` -> `{ daemon:{connected,last_seen,last_seq}, counts:{queued,waiting_approval,running,done,refused,failed} (queued, waiting_approval and running are current; done, refused, failed and the other finished states count only jobs finished since 00:00 UTC), needs_you:[Job + key:{id,label}], latest_events:[Event] (5), approvals:N }`.
- Keys: `GET /admin/keys` -> `[{id,label,prefix,contract:{id,name},created_at,last_used_at,revoked_at}]`; `POST /admin/keys {label, contract_id}` -> 201 `{id, label, key:"mr_live_..."}` (the full key appears only in this response; label 1..60 chars else 422 `{errors:{label}}`; unknown contract 422); `GET /admin/keys/:id` -> key + `recent_jobs` (10) + `contract`; `POST /admin/keys/:id/revoke` -> `{id, revoked_at, cancelled:N}` (queued, waiting and running jobs of that key become `cancelled` with reason `key revoked`; a running one is also cancelled on the laptop, which kills its whole process tree).
- Contracts: `GET /admin/contracts` -> `[{id, ...Contract, version, used_by:N}]`; `POST /admin/contracts` body = Contract -> 201, or 422 `{errors:{field:message}}` from `validateContract`; `PUT /admin/contracts/:id` same, bumps `version` (applies to the next job, and queued jobs are checked again just before they are sent); `GET /admin/contracts/:id`.
- Jobs: `GET /admin/jobs?state=&label=&limit=` -> `[Job]` newest first (default 50; `label` is an exact match; `/admin/parcels` is an alias of `/admin/jobs`; a result over 200 KB shows as its marker `{"$stored":{"bytes":N}}` in lists); `GET /admin/jobs/:id` -> Job + `timeline:[Event]` + `contract_check:{verdict,reason?}` (re-run now) + `key:{id,label}` (the full result, also a big one).
  `POST /admin/jobs/:id/approve` (state must be `waiting_approval`, else 409) -> `queued` and pushed if the daemon is connected; `POST /admin/jobs/:id/decline` -> `refused` with reason `declined by owner`.
- Events: `GET /admin/events?after=<seq>&limit=&tail=1` (`tail=1` returns the last `limit` events after `after`, oldest first, for a page's first load; without it you get the first `limit`, for replay) -> `{events:[...], last_seq}`; `GET /admin/events/stream?after=<seq>` -> Server-Sent Events, one `data: <Event JSON>` per event with `id: <seq>`, replaying everything after `after` first, then live; a `: ping` comment every 20 s.
- Laptop: `GET /admin/laptop` -> `{connected, last_seen, last_seq, rotated_at, credential_hint:"mrd_...9a3f"|null, queue:[Job] (state queued)}`; `POST /admin/laptop/test` -> `{ok:true, ms}` or `{ok:false, reason}`: a live round trip, the Hub sends `{type:"ping", id}` and the laptop must answer `{type:"pong", id}` within 5 s (no laptop connected, or no answer, gives `ok:false`); `POST /admin/laptop/rotate` -> `{credential:"mrd_..."}` (the only time it is shown; the old one dies at once and the live socket is closed with code 4001).

## Daemon protocol: `GET /daemon` (WebSocket upgrade, Bearer `mrd_...`)

Bad or missing credential: 401, no upgrade. One live daemon at a time: a new valid connection replaces the old (old gets close code 4002). Messages are JSON text frames.

Daemon -> Hub:
- `{type:"hello", version:"0.2.0", last_seq:N, rerunSafe?:["name",...], lanes?:{commands:{<name>:"short"|"long"}}}` first. Hub marks the daemon connected, appends `daemon.connected`, replies `{type:"welcome", server_seq:N}`, then pushes `queued` jobs in created order, at most one in flight per lane (see Lanes below). `lanes.commands` lists every command in the laptop's registry as `short` when its `timeoutMs` is 60000 or less, else `long`. A hello without `lanes` is an old daemon: one lane, one job at a time, as before. `rerunSafe` lists the registry commands flagged `rerunSafe: true` (a separate field; there is no `commands` list in the hello yet).
- `{type:"result", id, ok:true, result:<any JSON>}` -> job `done`. `{type:"result", id, ok:false, error:"..."}` -> job `failed` with `reason`. `{type:"refuse", id, reason}` -> job `refused` (the daemon's own contract re-check said no).
- `{type:"progress", id, text, pct?}` (daemon to Hub) -> stored as the latest progress of the job. `text` is capped at 500 chars, `pct` is clamped to 0..100. Accepted only for the job currently running on that daemon (anything else is ignored), cleared if the job is requeued, and returned as `progress` by the gateway and the admin job views. The daemon sends at most 2 per second. A `run` script reports by printing `MAILROOM_PROGRESS [<pct> ]<text>` lines on stderr (parsed by `daemon/progress.ts`); the `claude` task reports the current turn and tool (for example `turn 3: using WebFetch`).
- `{type:"pong"}` for each `{type:"ping"}` (Hub pings every 25 s; no pong in 60 s -> treated as disconnected).

Hub -> Daemon:
- `{type:"job", id, task, args, lane:"short"|"long", contract:<Contract>, contract_version:N}` (job becomes `running`, event `job.running`).
- `{type:"cancel", id}` when a running or queued job is cancelled, by key revoke or by the client (`POST /api/jobs/:id/cancel`). The daemon aborts it, kills the child's whole process group (children are spawned detached and killed with `kill -pgid`, helper `daemon/proc.ts` `killTree`), and sends no result.

Lanes: `short` = `echo`, `read_file`, `write_file`, and `run` of a command reported short in hello; `long` = `claude`, any other `run` (the Hub cannot know a command's timeout unless the daemon reported it, so unreported means long), and anything else. A long job never delays a short one; two long jobs (or two short ones) still run one after the other in created order. Cancel is by job id and works in either lane. The hint is a separate hello field (`lanes`) because the projects work's hello `commands` list was not in this tree. Logic lives in `shared/lanes.ts`.

On close the Hub appends `daemon.disconnected`. A job that was `running` goes back to `queued` only if re-running it is safe: `echo`, `read_file`, and a `run` of a command in the last hello's `rerunSafe`. Otherwise (`write_file`, `claude`, any other `run`) it ends `failed` with reason `laptop dropped mid-run; not re-run-safe` and is not run again. The same rule applies when the Hub restarts and finds a job still marked running. The daemon reconnects with backoff 1s -> 30s and runs jobs in order.

The daemon must re-run `check()` (with `home` set and paths `realpath`-resolved) before acting and refuse if it fails. Slice 1 tasks: `echo {text}` -> `{echo:text}`; `read_file {path}` -> `{content}` (max 200 KB); `write_file {path, content}` -> `{bytes}`. Slice 2: `claude {prompt, cwd}` -> `{output}` via `claude -p` in `cwd` with a 5 minute timeout (error `timed out after 300s`; the whole process tree is killed). Optional args (a contract can cap them, see below): `allowedTools` (array of 1-20 strings matching `^[\w:*() .\-]{1,100}$`, passed as `--allowedTools`), `maxTurns` (integer 1-50, `--max-turns`), `model` (string matching `^[\w.\-\[\]]{1,60}$`, `--model`), `json` (boolean; returns Claude's final JSON result object as `output`), `scratch` (boolean, see below). Invalid values fail the job. Internally the daemon always runs `claude --output-format stream-json --verbose` to report progress; the final result is the stream's `result` event (its `result` text plus a newline, or the whole object with `json`), the same shape as before. While a `claude` or `run` job runs on macOS the daemon wraps the child with `caffeinate -i -w <pid>` so the Mac does not idle-sleep (skipped when `caffeinate` is missing; released when the job ends or is cancelled). No shell is involved; all are argv entries. Slice 3: `run {command, args}` -> `{output, exitCode}`. The contract lists `commands: string[]` (names, `/^[\w.-]{1,60}$/`, non-empty when `run` is a task; a stored contract without it means none) and `check()` refuses a `command` not in it. Claude ceilings: the contract has `claudeTools: string[]` (1-20 tool names, exact match) and `claudeMaxTurns` (integer 1-50). `check()` refuses a `claude` job whose `allowedTools` has a name not in `claudeTools`, or whose `maxTurns` is above `claudeMaxTurns`. A job with no `allowedTools` / `maxTurns` gets exactly the contract values (the daemon passes them to `claude`), never the CLI defaults. A stored contract without the fields uses the safe defaults `["Read","Glob","Grep"]` and 10 turns; saving through `validateContract` stores them explicitly. The laptop policy (`~/.mailroom/policy.json`) has the same `claudeTools` and `claudeMaxTurns` ceilings (same defaults when missing): the daemon refuses a contract with `claude` whose tools or turns go beyond them, and its reasons name the `mailroom policy ...` command that fixes it (`allow-folder`, `allow-task`, `allow-command`, `allow-claude-tool`, `claude-max-turns`). The laptop's `~/.mailroom/commands.json` (mode 0600, read per job) maps each name to `{script (absolute), args: {name: {type: string|number|boolean|enum, required, maxLength, values}}, timeoutMs (default 5 min), cwd}`; the daemon refuses unknown commands, bad args, or a cwd that resolves outside the contract folders, and spawns `script --name value ...` as an argv array with no shell.

`scratch: true` (research mode): Claude runs with `cwd` set to a fresh `~/.mailroom/scratch/<jobid>-...` folder (mode 0700, deleted after done, failed, timeout and cancel), the contract folder (`cwd`) is passed as `--add-dir`, and if `allowedTools` is not given it defaults to `Read Grep Glob` clipped to the contract's `claudeTools` (a scratch job never gets more tools than the ceiling allows; if none of the three is allowed it fails). `allowedTools` and `maxTurns` are checked against the contract ceiling as for any `claude` job. What this enforces: Claude's default working area is the throwaway folder, and without write tools it cannot edit files. What it does not: Claude Code gives `--add-dir` folders the same permissions as the working folder, so there is no true read-only mount. If the caller passes `Write`, `Edit` or `Bash`, Claude can change the repo, and a crashed daemon can leave a scratch folder behind. Treat it as a safer default, not a sandbox.

## Idempotency

`POST /api/jobs` honours the header `Idempotency-Key: <1 to 200 printable characters>` (the client helper sends it for `submit(task, args, {idempotency})`). A repeat with the same key from the same client key within 24 hours returns the original job instead of creating a second one: `200 {id, state, idempotent_replay:true}` (state is the job's current state; an originally refused parcel answers `403` again, like the first time). The same key with a different `task` or `args` is `409 {error:"idempotency_conflict"}`. Key order inside `args` does not matter. A key is scoped to the client key; a malformed key is `422 {errors:{idempotency_key}}`. Without the header every submit makes a new job.

## Labels

`label` on `POST /api/jobs`: optional string, 1 to 60 characters after trimming, one line of plain text (control characters are rejected; markup is allowed and stored as typed because every view shows it as text). Longer or empty is `422 {errors:{label}}`. It is returned by `GET /api/jobs/:id` and the admin job views, filterable with `GET /admin/jobs?label=` (alias `/admin/parcels`), by the MCP tool `mailroom_list_parcels` (`label`), and shown as a small tag on the Parcels page. The client helper: `submit(task, args, {label})`. It has no effect on the contract check or the daily limit.

## Big results

A result up to 200 KB is stored in the job row. A bigger one (up to the 2 MB cap, `MAX_RESULT_BYTES` in `shared/limits.ts`) is stored in the separate `job_results` table; the job row keeps only a marker, and `GET /api/jobs/:id` and `GET /admin/jobs/:id` still return the full result. Lists (`GET /admin/jobs`, key detail) show the marker `{"$stored":{"bytes":N}}`. The stored result is kept 7 days; after that the job (and its events and small results) remain but the result reads as `{"expired":true,"bytes":N}`. Expiry is lazy: reads treat a result older than 7 days as expired, and the Hub deletes expired rows when it wakes, when a big result is stored and on reads of a job. Over 2 MB the job ends `failed` with reason `result is bigger than 2 MB` (the laptop reads at most 2 MB, cuts `claude` and `run` output at 2 MB, and checks the encoded size before sending).

## Event shape

`{seq, ts (epoch ms), kind, payload}`. Payloads: job events carry `{job_id, key_id?, task?, reason?}`; key events `{key_id, label}`; contract events `{contract_id, name, version}`; daemon events `{}`.

## Errors

Always `{error:"<code>", message?}` with the status above. 404 `{error:"not_found"}`, 405, 409 `{error:"conflict"}`, 422 `{error:"invalid", errors:{...}}`.

## Admin UI

Static files in `ui/`, served by the Worker (assets binding, `run_worker_first`). Unauthenticated requests get `ui/login.html` only; everything else needs a session. The UI is plain HTML, CSS and ES modules with no build step, dark and light themes (design: Lite project `the-mailroom`, canvases `v2` and `v2-light`; tokens in `docs/release-1.md`).
