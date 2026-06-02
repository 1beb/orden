# Annotation-to-Session Delivery Design

Date: 2026-06-01
Status: Design (brainstorm complete, ready to plan)

## Goal

Let the user send an annotation made on a planning doc (`docs/plans/*.md`) into the
agent session that brainstormed that plan. The link already exists: a card carries a
`planDoc` path (set via `card_set_plan`) and `sessionIds`. This feature reverse-resolves
from the doc the user is annotating back to the live (or relaunchable) session and
delivers the annotation as a queued message.

This is the **delivery layer**. It sits on top of the annotation record model
(`OrdenAnnotation`, source-keyed storage) described in
`2026-05-31-orden-web-annotation-design.md`, which is itself still design-stage. This
doc assumes that record exists and does not re-specify it.

## Why a TUI queue, not MCP push

The agent in a session is the MCP client; an MCP server cannot push unsolicited
messages to a client — the agent only sees a tool result when it calls a tool. So
delivery is NOT a new MCP tool. Instead the host (the only component holding the tmux
pane) types the annotation into the live pane. claude/opencode's own input queue holds
it for the agent's next available turn. This is the natural, already-working channel.

## Decisions

1. **Delivery = host types into the live TUI pane.** The TUI queues it for the agent's
   next turn. No relaunch when the session is already live.

2. **Trigger = explicit "send to agent"** on a chosen annotation (or a batch) in the web
   panel. Annotations the user makes for themselves never leak to the agent. On send,
   the annotation's `orden:status` flips `open → sent`.

3. **Dead session = relaunch + queue.** If the target session has no live pane, set
   `initialPrompt` + `pendingLaunch` and relaunch via `--resume <conversationId>`,
   reusing the existing launch-on-create machinery. The agent reads the annotation on
   start.

4. **Session selection = live one, else most recent.** A card may hold several
   `sessionIds`. Prefer any currently-live session; if none is live, target the most
   recent and relaunch it.

5. **No new MCP tool.** `@orden/mcp` contributes only a pure resolver helper; the act of
   delivery is host-owned and triggered from the web.

## Resolution chain & ownership

```
planDoc path (docs/plans/X.md)
  → card where card.planDoc === path            [reverse of cardSetPlan]
  → pick session: any live in card.sessionIds, else most recent
  → live pane?  yes → tmux send-keys into it
                no  → set initialPrompt + pendingLaunch, relaunch --resume
```

- **`@orden/mcp/sessionLink.ts`** gains a pure resolver
  `sessionForPlanDoc(vault, path)` mirroring `cardForSession`/`findCard`. Returns
  `{ card, session, candidates }`. No SDK, fully testable. Liveness is NOT decided here
  (the resolver has no tmux visibility) — it returns the card + its session list and the
  host picks the live/most-recent target.
- **The host** owns delivery. New method `queueToSession(sessionId, text)` in/near
  `terminal.ts`: if a live pane exists, `tmux send-keys` the literal text then `Enter`;
  else fall through to the `pendingLaunch` + `initialPrompt` relaunch path. The host also
  owns liveness detection (`tmux has-session`-style check it already does for attach).
- **The web** gets a "send to agent" action on an annotation that calls a host RPC
  (`annotationSend`), which composes resolver + target-pick + `queueToSession` and flips
  status to `sent`.

## What the agent reads

The queued text stands alone — the agent sees it as a line of input mid-conversation,
no UI affordance. It carries the quote, the note, and a pointer back.

Single annotation:

```
[orden annotation on docs/plans/X.md]
> "<exact quoted span from target.selector>"
<body.text note>
(annotation <id> — reply in-thread or resolve when addressed)
```

Batch (one message, numbered, header once):

```
[orden — 3 annotations on docs/plans/X.md]
1. > "<quote>"
   <note>
2. > "<quote>"
   <note>
...
```

Rules:

- **Quote comes from the selector, never a re-read of the doc.** `text-quote` selectors
  store `exact`. For `text-position`-only or `region` selectors, fall back to
  "see annotation `<id>` at block `<blockId>`". The host does NOT re-resolve anchors —
  that is the renderer's job, not delivery's.
- **The `<id>` is the contract back.** It enables a future `annotation_reply` tool that
  pushes into `orden:thread`. Out of scope here, but the id must be present.
- **send-keys hazard:** multi-line text via `tmux send-keys` can fire premature Enters.
  Send the body as one `send-keys -l` literal (no per-line Enter), then a single `Enter`
  to submit. Verify newline handling against claude's input box during implementation.

## Status lifecycle

- `open` → user is still working on the annotation; never delivered.
- `sent` → delivered (queued into a live pane, or seeded for relaunch). Set by
  `annotationSend`.
- `resolved` → user (or agent, via a future reply tool) marks it done.

Idempotency: re-sending an already-`sent` annotation is allowed (the user may want to
nudge again); it re-queues but does not duplicate the record.

## Edge cases

- **No card claims this planDoc.** The "send to agent" action is unavailable / the RPC
  returns a clear "no session linked to this plan" — surfaced in the web, no throw.
- **Card exists but has no sessions.** Same: nothing to target; inform the user.
- **conversationId not yet known** (session was created but never opened, so no
  conversation minted): treat as dead → relaunch path seeds `initialPrompt`, which is
  exactly what a first launch consumes.
- **Relaunch failure** must never throw into the web RPC — mirror `launchDetached`'s
  swallow-and-warn; the RPC reports best-effort outcome.

## Testing

- Pure resolver `sessionForPlanDoc`: unit tests in `packages/mcp/test` — match by
  planDoc, no-card, card-without-session, multiple-cards-same-plan (candidates).
- Message rendering: unit test the single + batch formatters and the selector-fallback
  (quote vs. "see annotation at block").
- Host `queueToSession`: unit test the live-vs-dead branch with a faked pane/launch
  surface; the actual `tmux send-keys` newline behavior is verified by running the app.
- Integration: annotate a plan in the running web app, click send, confirm the text
  lands queued in the agent's input (live) and that a closed session relaunches and
  reads it.

## Out of scope

- The annotation record model and storage (separate design, must land first or in
  parallel).
- `annotation_reply` (agent → `orden:thread`) — the `<id>` is carried so this is
  possible later.
- Any change to MCP tools.
