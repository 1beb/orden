# @orden/outliner

A framework-agnostic model layer for Orden's Logseq-style daily-journal outliner,
plus generic Kanban board primitives. Pure TypeScript, no runtime dependencies,
TDD'd with Vitest. Independent of `@orden/annotation-core` (does not import or
depend on it).

The board primitives here carry **no orden policy**: which lanes exist, their
order, their labels, and which count as "needs action" are all received as
parameters. Orden's actual lifecycle (the `planning → in-progress → blocked →
complete` lanes, the manual `on-hold` lane, completed-card TTL, needs-action set)
lives in `@orden/workflows` and `@orden/host-api`, not here. See
`docs/plans/2026-06-19-on-hold-and-lifecycle-config.md`.

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

### Generic board primitives (`src/kanban.ts`, `src/kanbanView.ts`)

A `Card<T>` / `Column<T>` is generic over the lane key `T` (`{ id, title, state:
T }`). The package has no opinion about which lanes exist — the caller supplies
the lane set, order, labels, and action lanes. Orden passes its `Lane` set (from
`@orden/host-api`); a generic consumer passes any string keys.

- `buildBoard<T>(cards, states)` — groups cards into one `Column` per lane, in the
  order the caller passes in `states`. A card whose `state` isn't in `states` is
  dropped.
- `renderBoard<T>(host, cards, opts)` — vanilla-DOM board (framework-agnostic).
  `RenderBoardOptions<T>` carries all policy: `states` (lane keys in display
  order), `labels` (display text per lane), optional `actionStates` (lanes that
  get the `orden-column--action` modifier and feed the board-level "needs action"
  badge; default none), optional `title` (default `"Board"`), and optional `doc`
  (injectable `Document` for testing/SSR; defaults to ambient `document`). Columns
  render in order, each with a per-column count badge.

## Run it

```sh
npm install
npm test         # vitest run
npm run typecheck
npm run demo     # vite dev server for the standalone demo in ./demo
```

The demo (`demo/`) parses a journal markdown sample, applies an outline
operation, renders it back to markdown, shows backlinks for one target, and
renders a board with mock cards — the demo defines its own lane set, labels, and
action lanes to pass into `renderBoard`, illustrating that the package bakes in
none of them. It imports the package source directly and is self-contained (not
part of `apps/web`).

## Tested (58 tests)

- `blockTree.test.ts` (21): create, indent/outdent edge cases, move, split,
  merge, collapse, find.
- `markdown.test.ts` (10): rendering, parsing (spaces/tabs, `*`, blanks),
  collapsed marker, full round-trip.
- `links.test.ts` (13): link extraction (dedupe, trim, empty), backlink index
  (nested, multi-page), journal keys (local-calendar-day filing).
- `kanban.test.ts` (4): `buildBoard` over a caller-supplied lane set — column
  order, grouping, within-column order, dropping unlisted lanes.
- `kanbanView.test.ts` (8): DOM structure, supplied labels, per-column counts,
  cards as list items, the `actionStates`-derived needs-action badge, the
  action-column modifier class, re-render — runs under happy-dom.
- `smoke.test.ts` (2): barrel exports.

## What's stubbed / simplified

- Backlink index is rebuilt from scratch each call — no incremental update.
- IDs are in-memory (timestamp + counter); a persisted scheme is needed once
  blocks are written to disk.
- The board view is read-only: no drag-and-drop, no state-transition wiring.
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
4. Board writes: drag-to-reorder and column moves emit lifecycle transitions, but
   the transition rules and lane set are orden policy (`@orden/host-api` /
   `@orden/workflows`), not this package — `renderBoard` only paints whatever lane
   set it's handed. Wiring writes through MCP, validated against that state
   machine, stays an `apps/web` + host concern.
5. Persistence: where pages live on disk (one markdown file per page / per day),
   and how `collapsed::` and other properties serialize alongside real content.
