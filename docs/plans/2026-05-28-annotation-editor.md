# Annotation Editor Implementation Plan

Supersedes the tail of `2026-05-28-annotation-core.md`. Reflects the marks-based
design (see `2026-05-28-orden-design.md`, Anchoring). Goal: get a styleable
ProseMirror editor with live annotation highlights and a document-ordered side
panel on screen quickly, then iterate visual styles.

## Architecture recap

- **Live anchor = ProseMirror mark.** An `annotation` mark over the selected range
  carries only an `id`. ProseMirror maps its position through edits, splits, and
  block reorders automatically, with native undo/redo. It orphans only when the
  marked text is deleted.
- **Durable store = the log** (`annotation-core` sink). Content keyed by id (body,
  target, thread, status, quote, edit history). Markdown stays clean — no inline
  ids.
- **Ordering = a document scan.** Walk `doc.descendants` for `annotation` marks;
  traversal yields document order by construction. Recompute on every update. No
  position store to keep in sync.
- **Cold start = quote re-anchor.** Markdown has no mark ids, so on load each
  logged annotation re-finds its stored quote (exact + prefix/suffix context) and
  re-attaches the mark. A quote that no longer matches is surfaced as orphaned,
  never re-pointed at unrelated text.

## Stack decision

- Editor slice lives at `apps/web/`, **Vite + TypeScript, vanilla** (no React yet).
  ProseMirror is framework-agnostic and does the heavy lifting; a framework can
  wrap this later without touching the editor/annotation logic. This keeps the
  fastest path to a visible, styleable result.
- ProseMirror packages: `prosemirror-model`, `-state`, `-view`, `-markdown`,
  `-schema-basic`, `-schema-list`, `-commands`, `-keymap`, `-history`.
- `@orden/annotation-core` is consumed for the model + log + cold-start matcher.

---

## Phase 0 — Close out annotation-core as model + log + cold-start matcher

TDD throughout. Commit per task, short messages, no attribution.

### Task 0.1: Fix resolveAnchor — context-disambiguated, orphan on miss

Replace Task 8's whole-document repair. New contract for `resolveAnchor(anchor, root)`:

- Find all occurrences of `quote.exact` in the document text.
- Zero occurrences → return `null` (orphan). Never approximate.
- Exactly one occurrence → use it (unambiguous even for a common word).
- More than one → pick the occurrence whose surrounding text best matches
  `quote.prefix`/`quote.suffix`; if none is a clear winner, return `null`.
- No bare "first match across all blocks" fallback — that was the false-match bug.

Tests (rewrite the repair tests):
- Single occurrence of a common word ("quick") with changed neighbors → resolves.
- The original false-match case (phrase gone, bare "quick" elsewhere, plus an
  unrelated "quick") → `null`, not a wrong match.
- Two occurrences, prefix/suffix disambiguates → resolves to the right one.
- Genuine reorder (phrase intact, moved) → resolves.

### Task 0.2: Finish the log (Task 9 from the old plan)

`MemorySink` + `sendFeedback` as specified, plus the durable record shape: the
log entry carries `quote` and an `edits` list (selected-text/edit history the
user asked to keep). Keep `SinkAdapter` as the seam (MCP sink later).

### Task 0.3: Barrel export + typecheck (Task 10 from the old plan)

Export the kept surface (`types`, `createAnnotation`, `createAnchor`,
`resolveAnchor`, `textOffsets`, sink). Mark `computeBlockId`/`assignBlockIds` as
not-the-anchor (keep exported for possible MCP `open_in_main_view` targeting, or
drop if unused after Phase 1). `npm test` green, `npm run typecheck` clean.

---

## Phase 1 — Visible editor slice (apps/web)

Logic pieces TDD'd; the view is built to be seen and styled.

### Task 1.1: Scaffold apps/web

Vite + TS. A single page with a full-height editor container and a right side
panel container. `npm run dev` serves it. Commit.

### Task 1.2: ProseMirror editor over markdown

- Schema: schema-basic + lists (+ tables later). Add an `annotation` mark to the
  schema: `attrs: { id }`, `inclusive: false`, rendered as
  `<span class="annotation" data-annotation-id="…">`.
- Load a sample markdown document via `prosemirror-markdown`'s parser; serialize
  back on demand. Wire history + base keymap.
- Render it. You can type. (No annotations yet.)

### Task 1.3: Add-annotation command

- A command/keybinding + a small floating button on non-empty selection.
- On invoke: mint an id, apply the `annotation` mark to the selection, and write a
  log record `{ id, quote (exact+prefix/suffix from the selection), body, target,
  status:'open', createdAt }`. Body via a simple inline input for now.
- Highlight appears immediately (the mark's CSS).

### Task 1.4: Document-ordered side panel

- A plugin (or a post-transaction hook) scans `doc.descendants` for `annotation`
  marks, collecting `{ id, from, to, text }` in document order.
- Render the panel list from that scan joined to the log (body/target). Re-run on
  every update so order tracks edits and reorders live.
- Click a row → select/scroll to the mark. Click a highlight → focus its row.

At this point there is something to look at and style.

---

## Phase 2 — Cold start + orphans

### Task 2.1: Persist and reload

- Serialize the doc to markdown (clean, no ids) and persist the log (localStorage
  is fine for the slice).
- On load: parse markdown, then for each logged annotation run the Phase-0
  matcher to find its range and re-apply the `annotation` mark.

### Task 2.2: Orphan surfacing

- Logged annotations whose quote no longer matches go to an "orphaned" section of
  the panel (a badge), linking to the record. Never re-anchored to unrelated text.
- Test the round-trip: annotate → reload → highlights restored in place; edit the
  quoted text → reload → that one orphans, the rest restore.

---

## Phase 3 — Visual style iteration (interactive)

Not a fixed task list — a loop. With the slice running, iterate on:

- Highlight treatment (underline vs background vs side-bar gutter), open vs
  resolved vs orphaned states, target (agent vs human) affordance.
- Panel layout, hover/active linking between highlight and row, orphan badge.

Drive with screenshots (playwright/run) and adjust CSS live. This is where we
converge on the look.

## Done criteria for the slice

- Select text → highlight + a panel row, in document order.
- Edit/reorder → highlight follows, panel order stays correct.
- Reload → highlights restored from markdown + log; edited-away quotes orphan
  (badge), never mis-anchor.
- `annotation-core` tests green, `apps/web` typechecks.

## Out of scope (still later)

- React/framework wrapper, the full three-pane shell, left nav, Kanban.
- MCP sink (ships batches to a session), SFTP I/O, tmux/session plumbing.
- Tables round-trip hardening, qmd/ipynb rendering.
- Yjs collaborative marks.
