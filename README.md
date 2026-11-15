# The Mailroom

A small, personal service that lets software in the cloud ask the Claude Code on one laptop to do work, safely. A Cloudflare Worker and one Durable Object are the gateway; a daemon on the Mac dials out to it. API keys are bound to contracts that say what each key may do, and the laptop enforces the contract again itself.

For personal use on the owner's own machine only. It is not a service for other people.

**Status: release 1 (v0.1.0) is the designs only. No running code yet.**

- `docs/ideas.md`: what it is and why
- `docs/architecture.md`: parties, credentials, data, job flow
- `docs/ui-brief.md`: the admin UI brief and journeys
- `docs/release-1.md`: what release 1 contains, the decisions, the evidence

Designs are in Lite (project `the-mailroom`, canvases `v2` dark and `v2-light`). To open them, export `LITE_TOKEN` and approve the `lite` server in `.mcp.json`.
