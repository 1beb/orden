# Omnisearch / command palette — design

Status: approved, ready to implement.

## What this is

The topbar search box (`#omnisearch`) is currently a stub: it wires Cmd+K focus,
Enter, and Escape, then fires a dead `orden:search` CustomEvent through an
`onSearch()` seam nothing listens to (`apps/web/src/main.ts:1666`). This design
replaces that seam with a real **omnisearch + command palette** — one input that
both navigates to entities and runs actions, following VSCode conventions.

## Decisions

One box, two modes (no scope prefixes — option A from brainstorming):

- Search mode (default): a plain query fans out to all sources at once; results
  render in fixed, labelled groups, each capped.
- Command mode: typing `>` (or opening with `Cmd+Shift+P`) switches the box to
  running actions. Backspacing the leading `>` returns to search mode.

Scope-filtering prefixes (`p:`, `f:`, VSCode's `@`/`#`) are deliberately omitted —
the fixed group hierarchy + per-group caps already do the disambiguation work, so
prefixes would be redundant cost for a single user.

## Keybindings (VSCode-faithful, plus the Cmd+K crowd)

- `Cmd/Ctrl+P` and `Cmd/Ctrl+K` → open in search mode. (Cmd+K is already wired to
  focus the input; add Cmd+P as an alias.)
- `Cmd/Ctrl+Shift+P` → open with `>` pre-filled (command mode).
- `↑`/`↓` move the highlight across the flat result list; `Enter` opens the
  highlighted row; `Esc` clears the query, then on a second press closes/blurs.

Note: VSCode reserves `Ctrl+K` as a chord prefix, not search — we intentionally
diverge there to match the modern web-app convention the codebase already started.

## Search sources, match fields, ordering

One query fans out to all five. Results stay in this fixed order regardless of
score — the hierarchy is the point. Each group is capped (~4 rows) with a
"+N more" affordance.

| Group    | Match against        | Opens via                       |
|----------|----------------------|---------------------------------|
| Journal  | block text + date    | journal view, scroll to block   |
| Pages    | title + body         | `openPage`                      |
| Projects | name + path          | project page                    |
| Sessions | title + state        | select session (right pane)     |
| Files    | path / filename only | `openRepoFile`                  |

Ranking within a group: fuzzy subsequence match score, recency as tie-breaker.
Groups themselves never reorder.

## Data sources

Journal, Pages, Projects, and Sessions are already hydrated client-side from the
vault (`hydratePages`/`hydrateProjects`/`hydrateCards`, `journal`), so those are
pure in-memory filters — instant, no host round-trip, and they stay live via the
existing `onVaultChange` feed.

Files is the caveat. The sidebar loads per-project file lists lazily (load-once),
so v1 **Files search = filename/path match over already-loaded lists only**.

### Deferred to phase 2

Full-text **file content** search needs a host-side ripgrep/grep endpoint on
`Host.files` (the browser can't scan disk). Out of scope for v1, which fits the
"files are the least interesting rows" call — filename matching is enough first.

## Architecture

Replace the dead `onSearch()` seam with a new `apps/web/src/commandPalette.ts`:

- A dropdown panel anchored under the topbar input.
- A `SearchSource` interface — `{ id, label, search(query): RankedItem[] }` — one
  implementation per group, reading the already-hydrated stores. The fixed group
  order is the order sources are registered.
- A `Command` registry for `>` mode — `{ id, title, run() }`.
- A small fuzzy matcher (subsequence scorer) shared by sources.
- Result selection reuses the **existing openers** (`openPage`, `openRepoFile`,
  journal/kanban/project view switches, session select), so no new routing is
  introduced — the palette is a new way to reach existing destinations.

`main.ts` keeps ownership of the keybindings and wires the palette to the stores
and openers it already holds.

## v1 command set (`>` mode)

Small, additive registry:

- New session
- New page
- Toggle outline / toggle annotations / toggle panes
- Switch view: Journal / Pages / Kanban
- Open settings

## Testing

- Fuzzy matcher: scoring + ordering unit tests.
- Each `SearchSource`: given a hydrated store fixture + query, returns the right
  ranked items, capped.
- Mode switching: `>` enters/leaves command mode; Esc clear-then-close.
- Keybindings: Cmd+P / Cmd+K open search, Cmd+Shift+P opens command mode.
- Selection routing: Enter on each group's row calls the right opener (mocked).

Follows the existing happy-dom + vitest patterns in `apps/web/test`.
