# The Mailroom, release 1: the designs (v0.1.0)

Release 1 is design only. There is no running code yet. It contains the approved UI, the evidence behind it, and the decisions that let slice 1 start.

## What is in it

**The admin UI, designed and played end to end in Lite** (project `the-mailroom`; needs `LITE_TOKEN`, see `.mcp.json`):

| Canvas | What |
|---|---|
| `v2` | Night shift (dark, primary). 34 screens, 6 scenarios. `validate_flow` ok, review score 100. |
| `v2-light` | Day shift (light twin of `v2`, same layout). 34 screens, 6 scenarios. Score 99. |
| `admin`, `inbox-home`, `row-actions` | The first design round and the two variants tested against it. Kept for history. |

Screens, in rail order: Sign in (wrong password, locked out), Overview (empty, laptop away), Parcels (loading, detail done, detail refused), Approvals (detail, decision recorded, empty), Keys (empty, new key, label error, key shown once, copied, detail, revoke confirm, revoked, list after revoke), Contracts (editor, validation errors), Events (reconnecting), Laptop (away, rotate confirm, new credential shown once).

**Journeys covered** (from `docs/ui-brief.md`): hand out a key, something is refused, approve a risky step, laptop is away, cut someone off. A sixth scenario walks every empty, loading and error state.

**Design system** (Lite project design system "Mailroom, night shift + day shift"): near-black canvas with hairline borders, 13px UI text on a 4px grid, mono for ids and keys, stamp orange only on the primary action, the Approvals count and the postmark. A light palette (`day-*` tokens) uses a darker orange so text and buttons keep contrast.

## Decisions taken for the owner

Each is recorded in ws-command as a lasting decision (d25 to d30). All can be reversed.

1. **Approvals live in the web UI** (d25), with a preview of what each step changes. A terminal prompt can be added later.
2. **A contract is what a key may do** (d26): allowed folders, allowed tasks, daily limit, expiry, which steps need approval. The daemon re-checks its own copy.
3. **The daemon and CLI are called `mailroom`** (d27): `mailroom login`, `mailroom run`.
4. **Slice 1 deploys to a personal Cloudflare account on a workers.dev subdomain** (d28). A custom domain comes before any client other than Dunder Miffbot.
5. **Build from v2** (d29): dark primary with a light twin, including the "Needs you" block on the overview. The row-actions variant is dropped.
6. **Daemon credential rotation is manual in slice 1** (d30): rotate from the Laptop page, the new credential is shown once, and the laptop is offline until it is pasted via `mailroom login`.

## Evidence

Tournament `t-0f93a723`: 5 goals, 3 designs, 2 runs each, 30 blind walks by simulated users (small Claude models). All 30 reached their goal.

| Goal | Base | Inbox home | Row actions |
|---|---|---|---|
| Hand out a key | 4 steps | 4 | 4 |
| Approve the waiting job | 4 | **2** | 3 |
| Cut off a key | 5 | 5 | 5 |
| Why was a request refused | 4 | **2** | 4 |
| Rotate laptop credential | 4.5 | 4 | 4.5 |

The inbox-home idea (act on approvals and see refusals from the overview) cut steps and is in `v2`. The "wrong turn" on cutting off a key is a scoring artefact: the shortest path goes through an already-revoked row.

## Known limits

- The users were simulated and there were two runs per cell. Treat this as a signal, not proof; check with real use.
- The Dark / Light switch in the top bar is drawn but not wired: Lite screens are static and a link cannot cross canvases. In the build it is `prefers-color-scheme` plus a toggle.
- The "Prototype states" page and links are prototype scaffolding, not product UI.
- The designs live in Lite, not in this repo. Exporting them here is not part of release 1.

## Next: slice 1 (auth)

Worker and Hub Durable Object, keys, contracts and the pure rule check, the gateway, the event log, owner login, the `mailroom` daemon with an echo job, then the admin UI screens above. Tracked as the ws-command group `the-mailroom`. See `docs/architecture.md`.
