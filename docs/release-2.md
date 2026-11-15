# The Mailroom, release 2: it runs (v0.2.0, fixes in v0.2.1)

**v0.2.1** verifies the browser extension in a real Chromium (a throwaway profile, not your Chrome) and fixes what that found:
the toolbar badge hid the approvals count behind a "!" whenever the laptop was away (the count now wins and turns amber), and
waiting parcels did not carry their key's label, so the popup could not show who asked (the Hub now sends `key:{id,label}`).
`node scripts/extension-e2e.mjs` is the check (see README). A `wrangler deploy --dry-run` also passes.

Release 1 was the designs. Release 2 is the working system, tested locally. It is **not deployed**: that needs your Cloudflare account.

## What is in it

- **Gateway and Hub** (`src/`): one Worker and one Durable Object (SQLite) following `docs/api.md`. Keys and the daemon credential are stored as SHA-256 hashes and shown once. Contract checks happen at the gateway; refusals are recorded and never reach the laptop. Revoking a key applies at once and cancels its queued and running jobs; editing a contract re-checks queued jobs. Owner login is an HMAC session cookie with a 5-tries-per-15-minutes limiter and an Origin check on every write. Events are append-only with `?after=` replay and a live stream.
- **Daemon** (`daemon/`): `mailroom login / run / status / logout`. It re-runs the contract check on its own copy before acting, resolves real paths (a symlink pointing outside an allowed folder is refused), runs `echo`, `read_file`, `write_file` and `claude` one at a time, reconnects with backoff, and stops if its credential is rotated.
- **Admin UI** (`ui/`): every page and state from the Lite designs (Overview, Parcels, Approvals, Keys, Contracts, Events, Laptop), dark and light plus a System setting, no build step.
- **Browser extension** (`extension/`): Chrome MV3. Toolbar badge for approvals waiting (amber if the laptop is away, grey if signed out), a popup, a read-only side panel, and a notification when a new parcel needs you. Actions stay in the UI. Load it unpacked, see `extension/README.md`.

## What was proven, and how

| Check | Result |
|---|---|
| `npm test` (contract rules, keys, sessions, login limiter, daemon against a fake hub, extension logic) | 44 pass |
| `npx tsc --noEmit` | clean |
| `scripts/smoke.mjs` against `wrangler dev` | 59 checks pass |
| `scripts/e2e.mjs`: real Worker + the real daemon + real files | pass: echo, read and write inside a folder, outside path refused, symlink escape refused with nothing leaked, write waits for approval and lands on disk after it, jobs queue while the laptop is away and run on return, a revoked key stops at once, events in order, signed-out visitors can load only the sign-in page's files |
| Real `claude -p` through the daemon's `claude` task | returned the expected answer |
| The UI in a real browser against the real Worker | Overview, Parcels, Approvals (approve clicked), Keys (create, copy once, revoke), Contracts, refused parcel, Laptop, Events, light and dark. No console errors. A live daemon connecting flipped the page to Connected and queued parcels ran |

## Found and fixed by running it for real

- The sign-in page loaded but its stylesheet and scripts redirected to the login, so it would have been unstyled and dead. The mock hid it. Fixed with an explicit allow-list of exactly those files, and the e2e now checks what a signed-out visitor can and cannot load.
- The e2e left `wrangler` and `workerd` running after it finished. Each child now runs in its own process group and is killed with it.

## Not proven, or known gaps

- **Not deployed.** No Cloudflare account was touched.
- **The extension is verified in real Chromium, with two limits.** `scripts/extension-e2e.mjs` loads it into a throwaway profile against a real Worker and checks: the service worker starts, the owner cookie authenticates the extension's requests, the badge count and tooltip, one notification per new parcel (not on the first poll, not twice), the popup and side panel with real data in dark and light, Review opening the Approvals page, the signed-out and not-configured states, no console errors. It grants localhost host access in the manifest up front, because Chromium's runtime permission prompt (`chrome.permissions.request` from the options page) cannot be clicked in automation, so **that prompt is still untested**, and so is whether the notification actually appears in the OS (the test checks the call, not the pixels). It has not been tried in Google Chrome or Brave.
- **UI flows not clicked on the real Worker:** saving a contract, widening a contract after a refusal, declining, and rotating the credential. Their API routes are covered by the smoke and e2e scripts and the builder exercised the screens on a mock.
- The 429 login lockout and the 60 requests a minute per-key limit are unit tested but were not driven against the live Worker. The SSE and daemon pings every 20 and 25 seconds were not waited on.
- `claude` tasks run with whatever permissions `claude -p` has on that machine. The contract limits the folder, not what Claude does inside it. Keep `claude` out of contracts you do not trust.
- The daily limit counts parcels per UTC day per key. The overview's "Today" counts show finished parcels since 00:00 UTC (fixed in this release: it first counted all time).

## Decisions kept

d25 to d30 stand (see `docs/release-1.md`).
