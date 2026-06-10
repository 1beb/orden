# ADR-0010: Annotation delivery via TUI typing, not MCP push

**Date:** 2026-06-01
**Status:** accepted

## Context

The user annotates a plan document in the main panel and wants to send that
feedback into the agent session. The agent is an MCP client; MCP servers cannot
push unsolicited messages to clients. Annotations must be delivered into the
agent's live conversation without adding a new MCP tool that the agent must
poll.

## Discussed in

Conversation `db143c6b-8f87-4974-9e1a-8d8284c452b9` (2026-06-01):

> "Orden MCP should be able to send annotations on planning docs into the session
> that brainstormed the plan. In another chat we discussed associated a card with
> a planning doc if it has one, we can leverage this relationship to get the
> session."

> "Most of the TUIs have the ability to queue a message, this is what should
> happen - the host should queue a message for next availability of the session."

## Decision

**The host delivers annotations by typing them into the live agent's TUI pane
via `tmux send-keys`. No new MCP tool for delivery.**

- Delivery is host-owned: the host holds the tmux pane, so it types the rendered
  annotation text directly into the agent's input.
- Claude Code / opencode's own input queue holds the message for the agent's
  next available turn.
- Resolution chain: `planDoc path` → card with matching `planDoc` → pick a live
  session (or most recent if none live) → queue via tmux.
- **Dead session = relaunch + queue.** If the target session has no live pane,
  set `initialPrompt` + `pendingLaunch` and relaunch via `--resume
  <conversationId>`, reusing the existing launch-on-create machinery.
- The queued text carries: source doc path, the quote (from the selector's
  `exact` field, never re-read from disk), the user's note, and the annotation
  id for future `annotation_reply` support.
- Multi-line text is sent as one `send-keys -l` literal (avoids premature
  Enters), then a single `Enter` to submit.
- `SessionManager.annotationSend` is the host RPC that composes resolver +
  target-pick + queue and flips annotation status to `sent`.

**Rejected alternatives:**

- **New MCP tool for the agent to poll.** Would require the agent to
  periodically call a tool to check for new annotations — unnatural polling and
  wastes agent turns.
- **MCP push (server sends unsolicited message).** MCP protocol does not support
  servers pushing messages to clients.
- **Write annotations to a file the agent monitors.** Fragile polling pattern
  that breaks the conversational flow.
- **Deliver via chat backend instead of TUI.** Chat is an optional GUI overlay;
  annotations must reach the agent regardless of which surface is active. TUI
  typing is the universal path.

## Consequences

**Easier:**

- Delivery is a single `tmux send-keys` call — the same mechanism already used
  to interact with the agent. No new protocol.
- The agent sees annotations as natural conversation input — no special handling
  required.
- Dead session relaunch reuses existing `pendingLaunch` infrastructure.

**Harder:**

- `tmux send-keys` with multi-line text has newline hazards — must use `-l` flag
  and verify behavior against each agent's input box.
- The quote is read once at annotation time, not re-resolved from the doc at
  delivery time. If the doc drifts, the queued quote may be stale (but this is
  intentional — the annotation is a snapshot).
- The delivery layer must resolve planDoc → card → session without tmux
  visibility, using only vault state.
