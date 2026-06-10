# ADR-0016: Session mode grid — TUI or GUI per tool, chosen at creation

**Date:** 2026-06-08
**Status:** accepted

## Context

Orden offers two surfaces for interacting with an agent: the Terminal (live TUI
in tmux) and the Chat (structured HTML transcript). The Chat view for Claude was
unreliable — it re-parsed the on-disk `.jsonl` transcript, which Claude only
appends completed blocks to, so the GUI could never stream tokens live and could
show stale state. The VS Code Claude Code extension solves this by spawning
`claude --output-format stream-json` as a separate process from the interactive
TUI — you can't make one Claude process be both an interactive TUI and a
structured live stream.

## Discussed in

Conversation `90ab168f-2e72-487a-abea-2514ba6376c8` (2026-06-08):

> "Chat is still very flaky. What can we do to make it more reliable?"

This led to investigating the root cause (transcript parsing can't stream).
The user then directed research into VS Code's approach:

> "vscode has this capability for claude and that's opensource. Investigate it
> and report back on how we might do this."

The VS Code Claude Code extension's approach (separate stream-json process for
the rich chat panel, interactive TUI as a different surface) was adopted as the
model for orden's session mode grid.

## Decision

**A session has exactly one mode (`tui` or `gui`), fixed at creation.
A settings grid (rows: Claude/openCode; columns: TUI/GUI) sets the default mode
per tool. The GUI for Claude streams live via the SDK with partial messages.**

Mode model:
- `Session.mode`: `"tui"` | `"gui"`. Fixed at creation; no parallel tabs or
  second process. Absent → legacy both-tabs behavior for backward compat.
- **TUI**: tmux interactive agent (today's path). The sessions panel shows only
  the Terminal tab.
- **GUI**: chat engine agent path. Claude SDK `stream-json` session with
  `includePartialMessages: true` for token-level streaming. No tmux process.
  The sessions panel shows only the Chat surface.
- Claude GUI streaming: the Claude adapter passes `includePartialMessages: true`
  to the SDK, which emits `stream_event` messages with `content_block_delta`
  for text and thinking deltas. These map to existing `DriverEvent` kinds
  (`text`, `thinking`). Deduplication ensures the final full message doesn't
  double-render after partials.
- Because a GUI session has no tmux, kanban card state is driven directly from
  `DriverEvent` turn boundaries (in-progress on send, blocked on turn-end)
  instead of injected tmux hooks — cleaner and sidesteps hook fragility.
- A scratch terminal button (`>_` affordance) launches a generic empty tmux
  shell (not bound to any agent/card), gated by a `showScratchTerminal` setting.

The settings grid (`defaultMode: { claude: "tui"|"gui", opencode: "tui"|"gui" }`)
defaults to TUI for both — no behavior change until the user opts in.

**Rejected alternatives:**

- **Both tabs always visible, with the Chat mirroring the TUI via transcript
  parsing.** This was the original path and it doesn't work: the transcript file
  is written in completed blocks, so the Chat can never stream live.
- **Make Claude emit both TUI and stream-json from one process.** Impossible —
  Claude Code can be interactive or streaming, not both in one process.
- **GUI for everything, drop TUI.** The TUI is the real agent experience — it
  carries permission prompts, slash commands, and stdin interaction that the GUI
  would need to reimplement. TUI stays as the default.

## Consequences

**Easier:**

- The GUI for Claude now streams live — text and thinking appear token-by-token
  rather than in block-sized chunks after the turn ends.
- GUI sessions have cleaner kanban state tracking (turn boundaries are native
  DriverEvents, not injected hooks).
- Users can choose TUI for power use, GUI for mobile/structured reading, per
  tool.

**Harder:**

- Sessions are locked to their mode at creation. A later phase (not in scope)
  will add a mode switch via `claude --resume` to flip between surfaces.
- The `thinking` event kind requires new plumbing: DriverEvent union widening,
  `reduceToVault` handler, `chat-ui` rendering, and adapter-contract test update.
- Deduplication logic (partials + final message) must be correct — a bug causes
  every turn to render twice.
- The scratch terminal is a separate `/term` branch that must handle tmux
  lifecycle without a Session record or vault entry.
