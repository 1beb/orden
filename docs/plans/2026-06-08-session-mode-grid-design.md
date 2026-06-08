# Session mode grid: TUI vs GUI per tool, with streaming GUI

Date: 2026-06-08

## Motivation

The native Chat (GUI) view is unreliable for Claude: it is populated by
`transcriptMirror.ts`, a 150ms-debounced re-parse of the on-disk transcript
`.jsonl`. Claude only appends *completed* blocks to that file, so the GUI can
never stream tokens or thinking — it shows steps after the fact, never live, and
a sent message can vanish. The Terminal (TUI) is the live process; the GUI
re-derives it from disk.

The VS Code Claude Code extension (verified by reading its installed bundle)
solves this by spawning `claude` with
`--output-format stream-json --input-format stream-json --verbose
--include-partial-messages` and rendering `content_block_delta` events live. It
does **not** attach a stream to an interactive TUI — its rich chat panel is a
separate `stream-json` subprocess; "terminal mode" is a different thing. You
cannot make one Claude process be both an interactive TUI and a structured live
stream.

So orden adopts the same model VS Code gives users: **pick one surface per
tool** — TUI or GUI — and stick with it. A later phase adds a clever switch:
flip the mode and resume the same conversation in the other surface via
`claude --resume` (both harnesses persist a resumable session id).

## Scope

MVP (this design):

1. Claude GUI streams live (text + thinking) via the SDK with partial messages.
2. A settings grid (rows: Claude Code, opencode; columns: TUI, GUI) sets the
   default mode used when a new session is created for that tool.
3. A scratch terminal button (a generic empty tmux shell), toggled by a setting.

Phase 2 (not in this design): the in-session GUI<->TUI switch via resume.

## The mode model

A session has exactly one mode, `tui` or `gui`, fixed at creation. Mode
determines which process spawns and which surface shows — no parallel tabs, no
second process.

Add `mode?: "tui" | "gui"` to the `Session` record (`packages/host-api`).

| | TUI | GUI |
|---|---|---|
| Claude | tmux interactive `claude` (today's path) | SDK `stream-json` session via `adapters/claude.ts`, token-streaming — no tmux |
| opencode | tmux interactive `opencode` | headless serve session via `adapters/opencode.ts`, SSE-streaming — no tmux |

This reuses what exists: `chatMount.ts` already has both a mirror path and a
standalone `agentClient` path. GUI mode always takes the agent path; TUI mode is
the terminal. `transcriptMirror` stops being the Claude default — it is only
reachable by legacy sessions with no `mode`, which keep today's both-tabs
behavior, so nothing breaks.

Sessions panel: a `gui` session shows only the Chat surface (no Terminal tab —
no tmux behind it); a `tui` session shows only the Terminal. The tab toggle in
`sessionsPanel.ts` becomes mode-driven rather than a free choice.

Because a GUI session is the chat engine (not tmux), its kanban card state can be
driven directly from `DriverEvent` turn boundaries (in-progress on send, blocked
on turn-end) instead of injected tmux hooks — cleaner, and it sidesteps the hook
fragility the idle-reconciler safety net guards against.

## Claude GUI streaming

Three changes in the host's Claude adapter path:

1. Ask for partials: `adapters/claude.ts`, add `includePartialMessages: true` to
   the SDK `Options`. The SDK emits
   `SDKPartialAssistantMessage = { type: "stream_event", event: BetaRawMessageStreamEvent }`
   (`@anthropic-ai/claude-agent-sdk@0.2.126`, sdk.d.ts:1365).
2. Translate deltas: `sdkMessageToEvents.ts` gains a `stream_event` case:
   - `content_block_delta` / `text_delta` -> existing `{kind:"text", messageId, text}`.
   - `content_block_delta` / `thinking_delta` -> new `{kind:"thinking", messageId, text}`.
   - `message_start` carries `message.id` -> the stable `messageId` for the turn.
3. Dedupe: with partials on, you also still get the final whole
   `SDKAssistantMessage`. Text/thinking come from the deltas; the final message
   is used only to finalize `tool_use` blocks. Otherwise every turn renders twice.

Supporting changes for the new thinking event kind:

- `chat-core/index.ts`: add `thinking` to the `DriverEvent` union (the `ChatPart`
  union already has `{type:"thinking"}`, so the vault model is ready).
- `reduceToVault.ts`: an `onThinking` that concatenates into a thinking part,
  mirroring `onText`.
- The adapter-contract test gains thinking ordering.
- `chat-ui/chatView.ts`: render a thinking part (collapsible, dimmed); today it
  only renders text/tool.

Text streaming is nearly free (downstream already streams incremental text, as
the opencode path proves). Thinking adds the new-event-kind plumbing.

## Settings grid + data flow

Extend `Settings` (`apps/web/src/settings.ts`):

```ts
defaultMode: { claude: "tui" | "gui"; opencode: "tui" | "gui" }
```

Default `{ claude: "tui", opencode: "tui" }` — no behavior change until the user
opts in. Validated/merged in the existing loader; persisted through the same
settings vault write-through.

The grid UI lives in the settings popover: a 2x2 grid, rows Claude Code /
opencode, columns TUI / GUI, one radio per row. Plain DOM matching existing
controls. A `showScratchTerminal: boolean` (default true) toggle is added here
too (see below).

Data flow at session creation:

1. The web `+ new` launchers (`sessions.ts` `createSession`) read
   `settings.defaultMode[agent]` and stamp `mode` onto the new `Session`.
2. The launch-on-create reactor (`serve.ts`) branches on `mode`: `tui` -> spawn
   tmux as today (`pendingLaunch`); `gui` -> no tmux; the session launches lazily
   when its Chat surface mounts and the agent client creates the streaming
   session.
3. `sessionsPanel.ts` reads `session.mode` and renders only that surface; absent
   `mode` -> legacy both-tabs behavior.

MCP-created sessions (`session_create`) default to `tui` (today's behavior)
unless the tool call specifies a mode. The per-project default agent
(`host-api`) is orthogonal — it picks which tool; the grid picks which mode.

## Scratch terminal

A generic empty tmux shell, not bound to any agent/card.

- Host: the `/term` handler gains a scratch branch. A reserved id (`scratch`) or
  `?scratch=1` launches `tmux new-session -A -s orden-scratch -c <filesRoot>
  $SHELL` instead of looking up a `Session` and running an agent. `-A` =
  attach-or-create, so it is a single reattachable scratch shell — no orphan
  accumulation. No `Session` record, no vault entry, no card.
- Web: a button in `sessionsPanel.ts` (a `>_` affordance in the panel header)
  mounts a transient terminal via `mountTerminal(container, "scratch")` — a
  throwaway surface, not a selected session; closing returns to the active
  session.
- Setting: `showScratchTerminal` gates the button's visibility.

Main host touch: the existing `/term` handler keys everything off a `Session`
record (tmux name, env, launch command); the scratch branch skips all of that.

## Error handling

- GUI stream failures: the engine pump currently swallows driver errors to
  `console.error` and leaves the session silently dead. For GUI mode this is
  user-facing, so a pump/driver error sets an error marker the Chat surface
  renders (extend the existing `chat-error` placeholder path in `chatMount.ts`
  to mid-stream failures). No silent hangs.
- Partial/final dedupe: covered by tests, not runtime guards.
- Legacy sessions (no `mode`): fall through to today's both-tabs behavior;
  explicitly tested.
- GUI launch with no chat backend (e.g. BrowserHost): the grid still shows, but
  creating a GUI session where `capabilities()` has no agent falls back to TUI
  with a one-line notice rather than a dead surface.
- Scratch terminal: tmux missing -> button hidden/disabled, same guard as agent
  terminals.

## Testing

- `sdkMessageToEvents`: `stream_event` text_delta -> text; thinking_delta ->
  thinking; the dedupe case (partials + final yields no duplication); tool_use
  still finalized from the whole message. (host)
- `reduceToVault`: `onThinking` concatenation, ordering vs text, `turn-end`
  closing. (chat-core)
- `chatStore` / `chatView`: renders a thinking part; gui-mode surface selection.
  (chat-ui)
- `settings`: `defaultMode` + `showScratchTerminal` load/merge/default; grid
  radio behavior. (web)
- `sessionsPanel`: `mode:"gui"` shows only Chat, `"tui"` only Terminal, absent ->
  both. (web)
- Scratch: `/term?scratch=1` launches a shell, not an agent; button visibility
  from setting.

## Phase 2 (future): GUI<->TUI switch

A switch action flips `session.mode` and resumes the same `conversationId` in the
other surface, closing the first process (no parallel). Claude: `claude --resume
<conversationId>` in tmux, or an SDK session resuming the id. Edge cases: an
in-flight turn at the moment of switch, re-pointing the UI, killing the prior
process.
