# ADR-0009: Kanban card-state semantics — completion is user-only

**Date:** 2026-05-31
**Status:** accepted

## Context

The kanban reflects each session's lifecycle. An agent should be able to signal
its own progress (working, stuck, finished) without being able to unilaterally
close a task. State changes must appear live on the board without polling.

## Decision

**Four lifecycle states: `planning`, `in-progress`, `blocked`, `complete`.
`card_move` cannot reach `complete`. Two routes to state change: hooks
(automatic working/waiting cycle) and MCP tools (deliberate moves).**

Card states:
- `planning` — idle, not yet started.
- `in-progress` — actively working.
- `blocked` — done with the current turn, waiting on user input.
- `complete` — finished. User-owned; can only be reached via `card_complete`.

**Hook-driven auto-cycle** (automatic, agent can't control):
- `UserPromptSubmit` → `in-progress` ("it's working").
- `Stop` / `Notification` → `blocked` ("done with the turn / waiting on you").

**Tool-driven deliberate moves** (agent controls):
- `card_move("in-progress")`, `card_move("blocked")`, `card_move("planning")`.
- `card_complete()` — ONLY path to `complete`. Rejected by `card_move` schema.

**Guard:** hooks must NEVER move a card that is already `complete` — otherwise
a subsequent `Stop` event would undo a completion.

The auto-cycle is driven by agent hooks (`apps/host/src/hooks.ts`), not MCP,
because MCP cannot observe the session lifecycle (it only sees tool calls).

**Live sync:** every vault write to `cards` ns flows through the existing change
feed; the web re-hydrates and re-renders the board on each change.

**Rejected alternatives:**

- **Agent drives all state changes via tools.** The agent can't set `blocked` as
  its own last act — the hook catches the turn boundary event that the agent
  itself cannot emit via MCP.
- **Five or more states.** The original design had `backlog`, `todo`, `ready` in
  addition to the four above. Simplified to four for clarity.
- **Agent can call `card_move("complete")`.** Would allow an agent to close a task
  without user review. Splitting `card_complete` into its own named tool makes
  completion a deliberate, review-gated act.

## Discussed in

Conversation `133fe10f-2853-47f0-902b-5e1495de659c` (2026-05-31), same session
as ADR-0008. When the agent asked about state semantics, the user provided the
canonical definitions:

> "\"Blocked\" means that it is either done or waiting for a response from the user.
> In-progress, means it's working. Planning means we've started a session but nothing
> is happening, yet. Complete is when the user specifies it's done. Mark as
> complete/this is complete, etc. Those should trigger the move to complete."

The agent initially proposed retiring hooks entirely in favor of agent-driven
`card_move`. The decision was refined to keep hooks for the automatic cycle
(UserPromptSubmit → in-progress, Stop → blocked) while the LLM drives deliberate
moves and is the only path to `complete`. This division of labor was explicitly
corrected during the conversation.

## Consequences

**Easier:**

- The board reflects real agent activity automatically — no manual "I'm working"
  tool calls needed for routine progress.
- Completion is always a deliberate user-approved act.
- The hook/tool division of labor is clear: hooks for lifecycle observation, tools
  for agent intent.

**Harder:**

- Hook lifecycle events depend on Claude Code's hook mechanism being configured
  and running. A hook gap (e.g., session started before hooks existed) means the
  board doesn't auto-track. The `idle-reconciler` safety net guards against this
  but adds complexity.
- The `complete` guard on hooks must be maintained — a regression here silently
  undoes completions.
- opencode hook integration differs from Claude's; parity must be maintained per
  harness.
