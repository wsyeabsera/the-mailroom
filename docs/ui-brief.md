# The Mailroom: UI brief (draft, input for `/prototype`)

Who: one person, Yab, the owner. Nobody else signs in.
Tone: a mailroom. Deadpan, calm, a little funny in microcopy ("3 parcels waiting", "Laptop is out to lunch"). Never at the cost of clarity.
Design rule: every screen has empty, loading, error and success states designed before any code. Dark and light themes.

## Journeys

1. **Hand out a key:** create a key, attach a contract, copy it once, see it appear in the list.
2. **Something is refused:** a client asks for a folder outside its contract; Yab sees the refusal and why, and widens or leaves the contract.
3. **Approve a risky step:** a job is waiting; Yab reads what it will do and approves or declines.
4. **Laptop is away:** the daemon is offline; jobs queue; Yab sees it and sees them run when it returns.
5. **Cut someone off:** revoke a key; it stops working at once.

## Screens (with states)

- **Sign in:** password; wrong password; locked out after repeated tries.
- **Overview:** laptop status (connected / waiting for laptop), parcels counts by state, latest events. Empty: "No parcels yet".
- **Keys:** list (label, contract, last used, status); empty; revoked styling.
- **New key:** label, contract picker or inline contract; success screen shows the key once with copy and a warning it cannot be shown again.
- **Key detail:** contract, recent jobs, revoke (confirm).
- **Contracts:** list; editor (folders, allowed tasks, daily limit, expiry, steps needing approval); validation errors; "used by N keys".
- **Jobs (parcels):** list filtered by state; detail with the event timeline, contract check result, result or error.
- **Approvals:** queue of `waiting_approval` jobs; approve / decline; empty "Nothing waiting for you".
- **Events:** live log (read-only), reconnect and "missed N events" notice.
- **Laptop:** daemon status, last seen, credential (rotate, confirm).

## Navigation

Left rail: Overview, Parcels, Approvals (with count), Keys, Contracts, Laptop, Events. Top bar: connection dot, theme, sign out.

## Decided / my calls

- Approvals live in this web UI (my call; the terminal-prompt option is not decided). **?**
- Single owner, no accounts or invites (same as `lite`).
- Plain tables and lists, no charts in slice 1.

## Next

Open Claude Code in `~/Hobby/the-mailroom` (with `LITE_TOKEN` exported), approve the `lite` MCP server, run `/prototype` with this brief, then `/tournament` for two or three visual directions.
