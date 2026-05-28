# Orden — Design

Captured 2026-05-28. A markdown outliner where any outline item can become a live
Claude Code / opencode session you talk to, drive autonomously, and review by
reading rather than writing code.

## The heart of it

Operate at intent, planning, and review — not at code. From a block in a daily
journal you spawn an agent session; it plans, works in isolation, and parks
finished work for you to read and react to. You judge results, not code. The
substrate must stay simple and reliable; the value is the loop, not the
machinery.

This replaces an earlier Logseq-based spike. Logseq's plugin surface became a
barrier, so Orden is a purpose-built web app assembled from decoupled pieces.

## Goals

- A markdown outliner (daily journal) as the primary authoring surface.
- Turn any outline item into an agent session (Claude Code or opencode).
- A planning conversation per task that sets the approach, unless a matching
  skill already exists, in which case run it directly.
- Sessions run in isolation (git worktree), locally or on another machine.
- Review by reading a rendered writeup and annotating it inline; annotations flow
  back to the agent.
- Two human touchpoints: approve the plan, review the evidence. Autonomy between.

## Non-goals for v1

- PDF annotation. Different anchoring model (coordinates, not blocks); a second
  annotation system. Revisit only if external-PDF review becomes real.
- Browser-extension host for annotating arbitrary websites. The annotation core
  is built modular so this is possible later, but foreign-site anchoring
  robustness is out of scope now.
- Off-device / push notifications.
- Real-time multi-user collaboration. The substrate choice keeps the door open
  (see Engine), but it is not built.
- A prescribed metrics / KPI schema for evidence. The app provides a slot; the
  metrics are domain-specific and discovered by use.

## Surfaces

Three panes, plus a left navigation rail.

```
┌────────────┬────────────────────────────┬─────────────────┐
│ LEFT NAV   │  CENTRAL VIEW              │  RIGHT: CHAT     │
│            │  (MCP-targetable)          │                 │
│ Journal    │  dual-mode:                │  the session's   │
│ Kanban (3) │   - Journal outliner       │  conversation    │
│            │     (WYSIWYG)              │                 │
│ PROJECTS   │   - rendered review doc    │  terminal by     │
│  ▾ ygqc    │     (md / html / qmd /     │  default;        │
│   • sess A │      ipynb)               │  structured      │
│  ▾ panel.. │                            │  transcript an   │
│   • sess C │  agent: open_in_main_view  │  optional layer  │
│            │  select text → annotation  │                 │
└────────────┴────────────────────────────┴─────────────────┘
```

### Left navigation

Top-level links to Journal and Kanban, then Projects with their Sessions nested
beneath. Clicking a project opens a descriptive project page. A small badge beside
Kanban shows the count of items needing action.

### Central view

The main work surface and the only pane an agent can drive. It is targetable over
MCP: an agent calls `open_in_main_view(path)` to put a document in front of you.
It operates in two modes:

- Journal outliner: an editable, WYSIWYG outliner (the daily log).
- Document review: renders md, html, qmd, or ipynb for reading and annotation.

### Right pane

The session's conversation. The terminal (the agent's real TUI) is the default
view. A structured transcript is an optional presentation layer over the same
session (see Engine).

## Data model

Markdown is the source of truth for document content. Entities are named, not a
single undifferentiated block soup.

- Project: a folder a session is assigned to. Owns Sessions. Has a descriptive
  page.
- Session: one agent run. Belongs to a Project, originates from a journal item,
  has a lifecycle state, and is hosted by a tmux process.
- Journal: a tree of outline blocks (the daily log), rendered by the outliner.
- Document: a rendered artifact (md / html / qmd / ipynb) attached to a session,
  e.g. a plan or a review writeup.
- Annotation: feedback anchored to a block (and optionally a text range) within a
  Document, with a target (agent or human), thread, and status.
- Card: a Session's projection onto the Kanban board, positioned by state.

Cards, plan documents, and review writeups are projections or attachments of a
Session rather than independent objects to keep mental overhead low.

## Session lifecycle

States move through:

```
backlog → todo → in-progress → blocked → ready → complete
```

`ready` means the agent has parked finished work for review. `blocked` means it
needs your input.

### Entry and the planning branch

Creating a session from a journal item starts here. The session enters the
backlog. Then one of two branches:

- A matching skill exists: run it directly. No plan document, no approval
  touchpoint.
- No matching skill: run a brainstorm that produces a plan plus an implementation
  plan, where you set the approach and (later, per domain) KPIs and targets. The
  plan document is shown in the central pane.

### The two human touchpoints

- Approve the plan (touchpoint 1). The plan opens in the central pane. Approval is
  an explicit state transition that releases the agent to build — see the action
  bar below.
- Review the evidence (touchpoint 2). At `ready`, the agent opens its writeup in
  the central pane; you read and react.

Between these two points the agent works autonomously.

## Interaction model

### The morphing action bar

Any editable document in the central pane carries one context-sensitive action at
the bottom, always visible:

```
clean doc                →  Approve
you edited content        →  Save Changes
you added annotations     →  Send Feedback   (target: agent default, or human)
you did both              →  send both — the modified doc and the annotations
                             go to the agent as one review
```

For a plan, the default is Approve; making annotations swaps it to Send Feedback,
and direct edits swap it to Save Changes. Approval is deliberately a button and
not inferred from prose, so the agent never has to guess whether you committed.

Routing rule:

- A document under an active session's review: edits and annotations are sent to
  the agent.
- The journal outliner (no session): edits just save locally.

Feedback target defaults to the agent. The alternative, share with a human, is
treated as export of the annotated document, not live collaboration.

### Annotation as a standalone module

Annotation is decoupled from the session plumbing so it can be reused (for
example, a future browser extension). Three seams:

- Source adapter: what content surface it attaches to, and how it computes anchors
  from a selection.
- Annotation model: anchor plus body plus target plus thread plus status,
  shaped after the W3C Web Annotation model so it is portable.
- Sink adapter: where batched feedback goes.

Orden is one host of this core (source is the central pane; sink is MCP to the
session). A browser extension would be another host (source is any page; sink is a
share endpoint) without changing the core.

### Anchoring

v1 targets md, html, and qmd, all of which have clear block structure, and anchors
to that structure.

- At render time, emit a stable block id per block, derived deterministically from
  the normalized document tree (block path plus content hash). Orden controls md
  and qmd rendering, so injecting ids is straightforward; for raw html, ids are
  assigned by structural path.
- An anchor is a block id plus an optional text-quote and offsets for sub-block
  selections.
- Resolve by id; if a block moved or changed on re-render, repair via the text
  quote.

The same anchoring engine can anchor structured transcript messages, since each is
a block with an id.

### WYSIWYG editing

The outliner and editable documents use a ProseMirror-based WYSIWYG editor,
Obsidian-style. Prose, structure, and tables are all supported (including
`prosemirror-tables`). The real risk is markdown round-trip fidelity, not the
editing surface. Markdown stays the source of truth and ProseMirror serializes
back to it. Editable-html is a per-document last resort only, since it breaks both
diffs and the agent's markdown input.

## Engine and transport

Three mechanisms with distinct jobs:

- tmux hosts the agent process. It provides lifecycle, durability (the session
  survives disconnects, which is exactly the desired "it keeps running"), and a
  uniform local-or-remote surface via ssh. Both Claude Code and opencode run as
  their normal TUIs in tmux. The terminal, rendered with xterm.js over the pty, is
  the default right-pane view.
- MCP is the structured message bus, used regardless of how the right pane is
  drawn. Both runtimes are MCP clients. Inbound: annotations and chat. Outbound:
  `open_in_main_view`, state transitions, and stuck/broken signals.
- A websocket is the app's live link to the backend for streaming output and
  control.

### Structured transcript

The terminal is the default; a structured transcript (in the style of the VS Code
Claude extension or opencode web) is an optional presentation layer. It is built
by reading each agent's on-disk session state, not by a headless mode:

- Claude Code: tail `~/.claude/projects/<slug>/<session>.jsonl`. The
  subscription-authenticated TUI already writes this, so there is no extra API
  cost. Headless `claude -p` is explicitly not used, because it would route
  through API billing rather than the subscription.
- opencode: read its server-backed session store or subscribe to its event API.
  The exact store path or API should be verified before building this adapter.

The right pane renders a Transcript model fed by a per-runtime adapter; a pty
adapter is the universal fallback for any other CLI agent.

### Multi-user door, left open

Real-time collaboration is not built. ProseMirror is, however, the standard
substrate for collaborative editing via Yjs and y-prosemirror, so the choice does
not foreclose it. If collaboration is added later, Yjs becomes the live source of
truth and markdown becomes serialization — a known migration, not a rewrite.

## Execution and file I/O

- Remote-capable from day one, cheaply, because a session is just a tmux process:
  local is `tmux`, remote is `ssh host tmux`, and the create / send-keys /
  capture-pane / kill surface is identical.
- Each session works in a git worktree under its assigned project folder, on
  whichever machine runs it.
- File I/O for the central pane is backend SFTP over the same ssh used for tmux.
  Reading a document for review and writing back on Save both go over SFTP. This is
  agent-agnostic and works identically for Claude Code and opencode.
- Syncthing is present on these machines but is deliberately not the transactional
  path for the review loop, because eventual consistency and conflict files break
  "Save, then the agent reacts now." It is fine for background or bulk movement.

## Evidence and trust

The premise — judge results, not code — only holds if the evidence at `ready` is
trustworthy, and the agent otherwise grades its own homework. The chosen model is
reproducible-by-construction evidence plus an independent verifier, but both are
deferred because they are domain-specific and cannot be specified before the tool
is used. This project is the first example: the right metrics are unknown until
the loop has been dogfooded.

The app therefore provides a slot, not a schema:

- `ready` requires an attached writeup artifact (Quarto or ipynb or md) that the
  app renders and lets you re-run. The app does not dictate its contents.
- An optional verifier hook can run a second session before `ready`. Wired in, off
  by default.

The metrics and targets are filled per task-domain later.

## Notifications

In-app only for v1. A small badge beside Kanban shows the count of items needing
action. Items needing action are sessions in `blocked` (needs your input),
`ready` (awaiting review), or a broken state (process crashed). No desktop popups
and no off-device push.

## Error handling

- Process crash: the tmux pane exiting unexpectedly marks the session broken and
  increments the Kanban badge.
- Stall detection: no pty output and no MCP heartbeat for a tunable interval while
  in-progress flags the session as possibly stuck.
- Reconnection: a dropped websocket reattaches to the still-running tmux session;
  no work is lost.
- Anchor repair: annotations whose block id no longer resolves are repaired via
  their stored text quote; unrepairable anchors are surfaced rather than silently
  dropped.

## Testing strategy

- Annotation core: unit tests for anchor computation, serialization round-trip,
  and repair against mutated documents. This module is pure and the most testable.
- Markdown round-trip: property tests that ProseMirror serialization is stable
  across edit cycles for prose, structure, and tables.
- Transcript adapters: fixture-driven tests that replay recorded session files
  (CC JSONL, opencode store) into the Transcript model.
- Lifecycle: state-machine tests for valid transitions and badge counting.
- Transport: integration tests for tmux create/attach/send/capture and SFTP
  read/write against a local sshd, then a remote host.

## Deferred and later

- PDF annotation.
- Browser-extension host for arbitrary websites.
- Off-device and desktop notifications.
- Real-time multi-user collaboration (ProseMirror plus Yjs).
- The concrete metrics, KPIs, and verifier policy for evidence.

## Open questions and risks

- opencode's exact on-disk session store or event API needs verification before
  the structured-transcript adapter is built.
- Markdown round-trip fidelity through ProseMirror, especially for tables and less
  common structures, is the main editor risk and should be proven early.
- The stall-detection interval and what counts as a heartbeat need tuning once the
  loop is in real use.
- Worktree creation, assignment, and cleanup policy per session is specified only
  at a high level and needs detail during planning.
