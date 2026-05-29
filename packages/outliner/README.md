# @orden/outliner

A framework-agnostic model layer for Orden's Logseq-style daily-journal outliner
and its Kanban board. Pure TypeScript, no runtime dependencies, TDD'd with
Vitest. Independent of `@orden/annotation-core` (does not import or depend on it).

## What's here

### Block-tree model (`src/blockTree.ts`)

A tree of bullet blocks. Each `Block` has `id`, `text`, `collapsed`, and
`children`. A single sentinel root (`createRoot`) holds the top-level bullets so
every real block has a parent, which keeps the operations uniform.

Operations (all mutate the tree in place, addressing blocks by id):

- `indent(root, id)` — nest under previous sibling (no-op for first sibling)
- `outdent(root, id)` — promote to a sibling of the parent, inserted right after it
- `moveUp` / `moveDown` — reorder among siblings
- `splitBlock(root, id, offset)` — Enter: head stays, tail becomes a new sibling
  that inherits the children; returns the new id
- `mergeWithPrevious(root, id)` — Backspace at start: fold text + children into the
  previous sibling; returns the id to focus, or `null` if first sibling
- `toggleCollapse(root, id)`
- `findBlock(root, id)` — depth-first lookup

### Markdown serialization (`src/markdown.ts`)

`toMarkdown` / `fromMarkdown` round-trip the tree to nested `-` bullets (two
spaces per level; `*` bullets also parse). The `collapsed` flag survives via a
Logseq-style `collapsed:: true` marker appended to the block's text. Markdown is
the source of truth, per the design doc.

### Pages and the daily journal (`src/page.ts`)

A `Page` is a named outline (`{ name, root }`). The daily journal is just pages
keyed by ISO date: `createJournalPage(date)` / `journalKey(date)`. `createPage`
makes a named non-journal page (e.g. a project page).

### Wiki links + backlinks (`src/links.ts`, `src/backlinks.ts`)

- `extractLinks(text)` — pulls `[[target]]` references in order, de-duped and
  trimmed; ignores empty `[[]]`.
- `buildBacklinkIndex(pages)` — walks every block of every page and returns
  `target -> BacklinkRef[]` (page name, block id, block text for preview).

### Kanban model + view (`src/kanban.ts`, `src/kanbanView.ts`)

Cards carry a `CardState`: the design-doc lifecycle
`backlog → todo → in-progress → blocked → ready → complete`, plus `broken` (an
error state for a crashed process, pinned last).

- `buildBoard(cards)` — groups into one `Column` per state in `LIFECYCLE_ORDER`.
- `needsActionCount(cards)` / `isNeedsAction(state)` — the left-nav badge count;
  needs-action = `blocked`, `ready`, `broken`.
- `renderBoard(host, cards, doc?)` — vanilla-DOM board: columns in order, a
  per-column count, a board-level needs-action badge, and a `--action` modifier
  class on actionable columns. `doc` is injectable for testing/SSR.

## Run it

```sh
npm install
npm test         # vitest run
npm run typecheck
npm run demo     # vite dev server for the standalone demo in ./demo
```

The demo (`demo/`) parses a journal markdown sample, applies an outline
operation, renders it back to markdown, shows backlinks for one target, and
renders a Kanban board with mock cards plus the nav badge. It imports the package
source directly and is self-contained (not part of `apps/web`).

## Tested (57 tests)

- `blockTree.test.ts` (21): create, indent/outdent edge cases, move, split,
  merge, collapse, find.
- `markdown.test.ts` (10): rendering, parsing (spaces/tabs, `*`, blanks),
  collapsed marker, full round-trip.
- `links.test.ts` (12): link extraction (dedupe, trim, empty), backlink index
  (nested, multi-page), journal keys.
- `kanban.test.ts` (7): lifecycle order, grouping, badge counting.
- `kanbanView.test.ts` (6): DOM structure, counts, badge, modifier class,
  re-render — runs under happy-dom.
- `smoke.test.ts` (1): barrel exports.

## What's stubbed / simplified

- Backlink index is rebuilt from scratch each call — no incremental update.
- IDs are in-memory (timestamp + counter); a persisted scheme is needed once
  blocks are written to disk.
- The Kanban view is read-only: no drag-and-drop, no state-transition wiring.
- `Card`s here are mock/standalone; in the real app they are projections of a
  Session and would be derived from session state.
- No editor: this is the model layer. The WYSIWYG surface is ProseMirror in
  `apps/web` and is intentionally not built here.
- Markdown parsing handles bullet outlines only — not arbitrary markdown
  (headings, tables, code blocks). Round-trip fidelity for rich content is a
  ProseMirror concern (see design doc).

## Open questions / next steps for apps/web integration

1. ProseMirror bridge: define how this block tree maps to/from a ProseMirror doc
   (list nodes), since the editor — not this model — owns live editing. Decide
   whether the block tree stays the in-memory source or becomes a serialization
   layer beneath ProseMirror (the doc notes Yjs as a later possibility).
2. ID identity: the design doc says ProseMirror nodes have no meaningful
   identity. Reconcile that with this model's stable block ids — likely the ids
   are an outliner-model concern only, recomputed/re-stamped on load, and not the
   annotation anchor (annotation-core uses marks).
3. Backlinks at scale: incremental index updates as blocks change, and resolving
   a `[[link]]` to a page vs. creating it on click.
4. Kanban writes: drag-to-reorder and column moves must emit lifecycle
   transitions (validated against the state machine) and route through MCP per the
   design doc, not mutate cards directly.
5. Persistence: where pages live on disk (one markdown file per page / per day),
   and how `collapsed::` and other properties serialize alongside real content.
