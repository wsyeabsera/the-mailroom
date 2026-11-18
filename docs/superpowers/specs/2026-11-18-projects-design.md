# Projects in The Mailroom: design

Date: 2026-11-18. Status: draft for approval. Part 1 of a larger effort (see "Order of work").

## Intent and why

The Mailroom is a flat list: keys, contracts, parcels, a laptop. The owner uses it from several client apps (tvdash's Worker, paperfolio, later others) that each run their own commands in their own laptop folder. To see what one app is doing, the owner has to piece it together across Keys, Contracts and Parcels. A **project** is the missing unit: one laptop folder plus the callers that use it. Each project gets its own page with its details. The owner chose the layout: a Projects home with one card per project, and tabs inside each project.

## Goals

- A project has a name, a laptop folder, notes and an optional colour, created and edited in the UI.
- Keys belong to exactly one project (or to the built-in "Unassigned"). A project's parcels are the parcels of its keys.
- The laptop reports its registered commands when it connects. A command carries an optional `project` tag in `~/.mailroom/commands.json`.
- Projects home: a card per project showing laptop status, what is running now (with progress), last run, today's counts, number of keys.
- Project page with tabs: **Overview, Parcels, Keys, Commands, Events, Settings**.
- Admin MCP tools to read projects (read scope) and create or edit them (write scope).
- A client-facing `GET /api/commands`: the commands the calling key may run (its contract's commands, joined with what the laptop reported).

## Non-goals

- Multiple users, roles or per-user access. Still one owner.
- Per-project secrets, billing, quotas or per-project daily limits.
- Moving enforcement. A project grants nothing.

## Anti-goals (failure even if it technically works)

- A project folder or tag widening what a key may do. Contracts (Hub) and the policy ceiling (laptop) stay the only gates, unchanged.
- The Hub trusting the laptop's report for security. The report is for display only.
- Breaking existing keys, contracts, clients or the live Worker's data on deploy.

## Constraints

- State is Durable Object SQLite in `src/hub.ts`; schema is created with `CREATE TABLE IF NOT EXISTS`, so new columns need a guarded `ALTER TABLE` that is safe to run on every start.
- The daemon's WebSocket `hello` message is the only place the laptop speaks unprompted; an old daemon sends no report and must keep working (the UI says "laptop has not reported commands").
- The admin UI is plain HTML, CSS and ES modules with no build step; keep it that way.
- Hub rate limit is 60 requests a minute per key; the UI polls the admin API, not client keys.

## Approaches considered

1. **Hub owns projects; the laptop reports facts (chosen).** New `projects` table; `keys.project_id`; the daemon sends its command list on hello. Trade-off: a project lives in two places (Hub row, `project` tag in `commands.json`), so a mismatch must be shown, not hidden.
2. **Laptop owns projects** (`~/.mailroom/projects.json`, Hub mirrors). Fits "the laptop decides" but a project cannot be created from the UI. Rejected: works against the goal.
3. **Derive projects from keys and folders.** No table. Rejected: no empty projects, no names or notes, fragile when contracts change.

## Design

**Data.** `projects(id 'pr_1000..', name, folder, notes, color, created_at, archived_at)`. `keys.project_id` nullable; null means Unassigned. The reported-commands snapshot is one row in a new table `laptop_report(id=1, commands TEXT json, reported_at)`, replaced wholesale on every hello, so the Commands tab works while the laptop is away, labelled "last reported". (The existing `meta` table holds integers only.) The Hub treats the report as untrusted: at most 200 commands, names `/^[\w.-]{1,60}$/`, at most 20 arg names of 60 chars each, anything else dropped.

**Daemon.** `hello` gains `commands: [{name, project?, argNames, timeoutMs}]` read from `commands.json` (never the script path or cwd). It re-sends when connecting. Policy values are not reported.

**Admin API (owner session or `mra_` token with scope).**
`GET /admin/projects`, `POST /admin/projects`, `GET /admin/projects/:id` (details: keys, counts, running job with progress, last run, commands), `PATCH /admin/projects/:id`, `POST /admin/projects/:id/archive`. Keys: `POST /admin/keys` accepts `project_id`; `PATCH /admin/keys/:id {project_id}` moves a key. Events: `project.created`, `project.updated`, `project.archived`, `key.moved`.

**Client API.** `GET /api/commands` with a client key returns `[{name, args, timeoutMs, on_laptop}]` for commands in that key's contract. Display help only; the laptop still decides.

**UI (direction B).** Routes `#/projects` (cards) and `#/projects/:id/:tab`. Top nav: Projects, Laptop, Tokens, Docs; existing global pages (Parcels, Keys, Contracts, Events) remain reachable as "All" views. Keys created inside a project preselect it. Unassigned is a card with a "File these keys" prompt. Empty states explain the next step.

**Migration.** Existing keys become Unassigned. Nothing is deleted or renamed; the live Hub upgrades in place on deploy (probe-check as before).

## Calls made while writing this (mine, not the owner's; check them)

1. **Commands tab = union, grouped.** (a) commands tagged to this project; (b) commands allowed by the contracts of this project's keys. A **mismatch** is shown as a badge on the command: a key in project A is allowed a command tagged to project B, a tag names a project that does not exist or is archived, or a contract names a command the laptop did not report. Untagged commands appear in one "Untagged on the laptop" list on the Laptop page, never under a project.
2. **Archive** is refused while the project has active (unrevoked) keys: the owner moves or revokes them first. An archived project is hidden from the home page behind an "Archived" toggle, can be unarchived, keeps its parcels and events in the global views, and a key cannot be moved into it.
3. **"Running now", "last run", "today"** come from the jobs of the project's keys (`jobs.key_id`); "today" is UTC, like the daily limit. Queued jobs are shown as a count on the card. Unassigned is computed the same way, over keys with a null project.
4. **Scopes.** Reading projects is `read`; creating, editing, archiving and moving keys is `write`. The existing MCP key tools gain an optional `project_id`; one new `mailroom_move_key` tool is not added (editing a key's project goes through the same update call).
5. **`folder`** is a free-text label (`~/...` or absolute), optional, not unique, never compared with anything; it only pre-fills the folder when creating a contract in that project.
6. **`GET /api/commands`** returns, for each command in the calling key's contract: `{name, on_laptop, args (names, or null), timeoutMs (or null)}`; the last two are null when the laptop has not reported it. Names are the same in the contract and in `commands.json`. It counts toward the 60 requests a minute and is not written to the events log. Argument names are display-only and not sensitive; script paths and cwd are never reported.
7. **Old daemon proof.** `tests/daemon-helpers.ts` has a fake Hub; add a test with a hello that carries no `commands` (what an old daemon sends) and assert the Hub accepts it and the UI state says "laptop has not reported commands". No pinned old handler is needed.
8. **Navigation.** Top level is Projects, Laptop, Tokens, Docs, plus an "All" menu holding Parcels, Keys, Contracts, Approvals and Events. Existing routes (`#/keys`, `#/parcels`, ...) keep working unchanged. The key-creation form gets a project picker, preselected when started inside a project.

## What is left to the builder

Visual style (colour, type, spacing) is a separate step, part 2; build part 1 on the current tokens. Exact card contents, tab internals, copy, the shape of the `argNames` summary, and test layout.

## Order of work

1. **Projects** (this document), including the new shell and navigation.
2. **Professional UI upgrade**: visual system, applied across all pages.
3. **Professionalise**: CI, releases and rollback, observability, security review, retention and backup, guided install.
4. **Remaining tasks #2775 to #2781**: callback URL, lanes and approval push become per-project settings after part 1; the four small tasks (#2780, #2778, #2776, #2781) can run in parallel any time.

## Proof for part 1

`npm test`; `scripts/e2e.mjs` extended (create project, assign key, run a tagged command, project page data); a real-browser pass of every tab; deploy and probe-check on the live Worker; an old daemon still connects.
