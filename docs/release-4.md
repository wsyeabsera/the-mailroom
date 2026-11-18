# The Mailroom, release 4: the docs site, and fixes (v0.4.0)

## The docs site

16 pages in the admin app at `/docs/` (behind the owner sign-in, nothing new is public): the big picture, a 10-minute quickstart, how a parcel travels, keys and contracts, parcels and approvals, the laptop and daemon, a tour of the admin app with real screenshots, the browser extension, Claude and MCP, the security model, the `mailroom` command, the HTTP API, events, troubleshooting and a glossary. Diagrams are hand-drawn SVG that follow the dark and light themes. A Docs link sits in the app's rail. No build step: the pages are plain HTML in `ui/docs/`.

Checked in a real browser (`scripts/docs-check.mjs`): every page in dark, light and at phone width, no console errors, every link and section anchor resolves, every diagram has a title and description, nothing scrolls sideways on a phone. Then an independent reviewer checked every factual claim against the code; what it found was fixed.

## Fixes found along the way

- **`mailroom status` kicked your running daemon off.** It opened a second daemon connection, which made the Hub replace the real one (the daemon exited; under launchd it came back about 30 seconds later, so the laptop flickered to "out to lunch"). `status` and `service status` now ask `GET /daemon?probe=1`, a read-only check that never touches the live connection. **This needs the Hub redeployed**: against an older Hub, `status` says "unknown (this Hub is older than v0.3.3...)" instead of guessing.
- **The Events page showed the oldest 100 events**, so with a long history the middle went missing. It now loads the latest 100 (`tail=1`) and streams live.
- **My CLI end-to-end test could have replaced a real background service** (it used the same launchd label). It now uses its own label and refuses the default.
- Overview greeting no longer hard-codes a name; token and MCP events read properly in the app; the amber status pill no longer renders as a callout.

## A correction to what earlier notes claimed

Earlier docs and release notes said the daemon enforces the contract on its own copy, so a compromised Hub could not widen what the laptop does. **That was wrong.** The Hub sends the contract inside every job and the daemon checks that one. The laptop's check still adds real-path and symlink resolution, `~` expansion with the laptop's home, the laptop's own clock, and catching Hub bugs, but it does not protect against a compromised Hub. The docs, README and architecture notes now say this plainly. The next hardening step is a laptop-side ceiling: folders and tasks set on the laptop that the daemon refuses to go beyond whatever contract arrives. Not built.

## Proven

76 unit tests; typecheck; `scripts/e2e.mjs` (now includes the probe and tail checks); `scripts/cli-e2e.mjs` (status leaves a running daemon connected; the real launchd service); `scripts/docs-check.mjs` over all 16 pages.

## Not done

- **The live Worker is still v0.3.0.** The docs, the `status` fix and the Events fix take effect once it is redeployed.
- Known at v0.4.0, since fixed: a parcel that was running when the laptop dropped could run a second time (now only if re-run-safe), and cancelled parcels counted toward the daily limit (they no longer do).
