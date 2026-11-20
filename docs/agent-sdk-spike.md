# Spike: Claude Agent SDK instead of `claude -p` (#2919)

Date 2026-11-19. Claude Code 2.1.328, `@anthropic-ai/claude-agent-sdk` 0.3.328, macOS, the owner's own logged-in Claude Code. Scripts were run in a scratch folder and are not part of this repo; nothing in the daemon was changed for this spike.

## Verdict

**No-go as a replacement for `claude -p` now. Go later, as an opt-in mode, only if mid-run approvals become a product need.** Everything the daemon needs today (a hard folder boundary, no shell, denials reported back) is done with `claude -p` flags (see `docs/api.md`, "Claude job confinement"). The one thing the SDK adds that `-p` cannot do is pause a run and ask the host, and that is only worth a new dependency if we want the owner to approve a tool call while the job is running.

## What was tried and seen

| Question | Answer (observed) |
|---|---|
| Works with the logged-in subscription, no API key? | **Yes.** `query()` started, the `system/init` event said `apiKeySource: "none"`, and it ran 2.1.328 (same as the installed CLI). No `ANTHROPIC_API_KEY` was set. |
| Streaming events? | **Yes, richer than `-p`.** With `includePartialMessages: true` a 10 s run produced 45 `content_block_delta` stream events, plus `message_start/stop`, `assistant`, `user` (tool results), `system/status`, `rate_limit_event` and a final `result`. `-p --output-format stream-json` gives whole `assistant`/`user` messages only (no token deltas). |
| Tool events? | Same `assistant` `tool_use` and `user` `tool_result` messages as `-p`, plus the final `result.permission_denials`. Equivalent, not better. |
| A `canUseTool` hook `-p` lacks? | **Yes, and it really pauses the run.** A `Write` into the job folder called `canUseTool(toolName, input, {toolUseID, signal, suggestions, blockedPath, decisionReason, ...})`; the callback waited 3 s (an owner "thinking"), then returned `{behavior:"allow", updatedInput}`; the run resumed and the file was written ("approved-by-host"). `-p` can only deny up front (with `--permission-mode dontAsk` it never asks). |
| Does `canUseTool` see every call? | **No, and this is the trap.** It is consulted only when Claude Code would otherwise ask. In the first spike a `Read` inside the cwd and `Bash 'echo hi'` (a "safe" command) ran **without** the callback; only the `Read` outside the folder reached it. A bare name in `allowedTools` shadows it too (the SDK prints `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`). So `canUseTool` is an approval channel, not a security boundary: the boundary must stay the deny rules and `disallowedTools` (as in the daemon today) or a `PreToolUse` hook. |

## Costs

- **Weight and coupling.** The package pulls a 352 MB platform binary (`@anthropic-ai/claude-agent-sdk-darwin-arm64`) unless `pathToClaudeCodeExecutable` points at the installed `claude`. Versions track the CLI (0.3.328 = 2.1.328), so it moves with Claude Code releases. The Mailroom has one runtime dependency (`ws`) on purpose.
- **Startup is the same** (about 3 s to `init`, user hooks included), so no speed win.
- **A second code path.** Session resume, budgets (`num_turns`, wall time), cancel (kill the process group), scratch folders, the stream reader and the log writer are all written against the `-p` child process. The SDK would need all of them redone and retested.
- **Terms.** It is the same login as `claude -p`, used on the owner's own machine for the owner's own apps. Re-read the current terms before shipping anything that lets other people's software drive it.

## If we do it later

Add an `approval: "interactive"` mode for a claude job: run the SDK with `permissionMode: "default"`, no bare file tools in `allowedTools`, the same scoped `Read(//dir/**)` rules and `disallowedTools` as today, and turn each `canUseTool` call into a Hub approval (the job goes `waiting_approval` with the exact tool and input, `signal` aborts it on cancel or timeout). The mapper in cf-os `apps/chat/src/brain/permissions.ts` already produces the approval-card shape from a permission denial; it could take `canUseTool` input as a second source. Keep `claude -p` as the default.
