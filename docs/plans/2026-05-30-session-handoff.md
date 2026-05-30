# Session handoff — 2026-05-30

Status: stopping point for a long session. Everything below the "Shipped" line is
committed; the "Open items" are queued for the next session.

## What orden is (orientation)

Local-first work hub: a Node host (`apps/host`) serves the web app (`apps/web`)
over one HTTP server on port 4319 (app + WebSocket RPC/change-feed + `/mcp` +
`/term` pty + `/hooks`). State lives in a disk vault at `~/.orden/vault` (one JSON
per key, namespaced). The web app's stores hydrate from the vault at boot and
write through; the host pushes a change feed so the UI live-updates. AI sessions
are the real interactive agent TUI (claude/opencode) in tmux over `/term` — never
headless `claude -p`.

Key files: `apps/host/src/{serve,nodeHost,diskVault,fsFiles,terminal,hooks,nodeSessions,transcriptTitle,opencodeSession}.ts`;
`apps/web/src/{main,sessions,sessionsPanel,cards,projects,projectPage,kanban,pages,pagesIndex,journal,outlineEditor,agentMarks,recentFiles}.ts`;
shared types in `packages/{host-api,outliner}`.

## Shipped this session (commits)

- `e4cc081` — sessions are TUI-only (removed the `claude -p` chat runner; `prompt()`
  throws); agent brand-mark icons (Claude sunburst / opencode square) in the picker
  and per-session badges; topbar/row icons converted to inline SVG (font-independent);
  4-state kanban (Planning / In-progress / Blocked / Complete) with legacy migration;
  `[[Project: X]]` links; host watches repo `.md` files so open docs live-reload;
  tmux `mouse on` + `window-size latest` for mobile; remember last open session;
  agent-state hooks (UserPromptSubmit → In-progress, Stop → Blocked) + a "waiting"
  toast.
- `47192ee` — start a session from a card (C/O launcher on cards/rows with no
  conversation, links to the existing card); assign a card's project inline; drop
  the "ephemeral" label (project page header + left-nav list).
- `7b56180` — mission-control project page (Active sessions / Items / Project notes
  (embedded outline page, key `notes:<projectId>`) / activity (stubbed)); shared
  `outlineEditor` extracted from the journal; opencode parity (discover + resume
  session id via `--session`, title from `opencode session list`); Notification hook
  → Blocked (covers mid-turn questions, which `Stop` does not).
- `2ab264f` — delete pages (Pages index ✕ + confirm); case-insensitive page
  resolution (`[[agentnote]]` opens `AgentNote`); FILES nav shows the 5 most-recently
  opened files; clickable file explorer on file-backed project pages; reassigning a
  card with a session moves the session too.

Hook state transitions were verified end-to-end against the live endpoint
(in-progress / blocked / notification-permission → blocked / auth_success ignored).

## Open items (next up)

### 1. File tree explorer (in progress — decisions captured, not built)

Goal: browse the ENTIRE file structure like VSCode, not just markdown.

Decided:

- Build the tree UI by hand (vanilla DOM) — no good library fits orden's
  no-framework setup. Must be COLLAPSIBLE (expand/collapse folders), lazy per
  directory (never walk a huge tree).
- Extend the host `FileSource` (`apps/host/src/fsFiles.ts`) with a per-directory
  listing that returns ALL entries (files + dirs), not just `.md`, skipping
  `node_modules`/`.git`/`dist` (existing `SKIP_DIRS`); consider honoring
  `.gitignore`. Today `list()` flattens + filters to `.md` only.
- Clicking ANY file opens it in the main view window (the user's stated intent).

To resolve: how rich the viewer is for non-markdown files. The review pane today
only renders markdown (ProseMirror). Options discussed: (a) plain text read-only
(no deps), (b) syntax-highlighted read-only (Shiki/highlight.js), (c) CodeMirror 6
(view + edit), (d) Monaco. The user's answer ("clickable, sends whatever file into
the view window") confirms click-to-open but did not pin the viewer richness —
start simple (markdown in the editor, other text read-only, images as `<img>`) and
layer highlighting/editing later, or confirm with the user first.

### 2. Pages list

- Show a "last updated" value in the Pages index. `pagesIndex()` already returns
  `updated` (from the `pagemeta` vault ns); `pagesIndex.ts` currently shows Created
  + Backlinks only. Add an Updated column.
- There is a RENDERING PROBLEM with the pages table (user-reported, unspecified).
  Investigate `renderPagesIndex` / `.pages-table` CSS — likely the new delete-button
  cell (added this session, inline-styled) misaligned the table, or column widths.
  Reproduce and fix.

### 3. Activity feed (project page)

Currently a stub ("needs an event log"). Cards/sessions carry no timestamps, so a
real reverse-chron feed needs an event log (or timestamps on cards/sessions). Design
separately.

### 4. Smaller / deferred

- Annotations on wiki pages: not supported (annotations are a review-doc feature).
  If wanted, design separately.
- Per-project file roots: `FsFiles` is single-rooted at the repo; a file-backed
  project's explorer lists repo files, not the project's own path. Real multi-root
  support is pending (H2.2).
- opencode session-id discovery has a small race (newest session in cwd) if a
  separate opencode session is created in the same dir during the launch window.
- Card with a missing/unknown project dead-ends on click ("project not found");
  could degrade gracefully (offered, not done).

## Gotchas / operational notes

- No git remote is configured — all commits are local only.
- `.claude/settings.local.json` holds the agent hooks and is gitignored, so it lives
  only on this machine and won't travel to other clones.
- Hooks only attach at `claude` startup and only fire for orden-launched sessions
  (env `ORDEN_MANAGED=1`). A session started before the hooks existed can't be
  retrofitted (`tmux -A` only re-attaches) — start a NEW session to see card state
  move. Stop fires at end-of-turn; mid-turn questions fire Notification instead
  (now handled).
- The host runs `tsx src/serve.ts` (the non-watch `start` script). Host-side changes
  need a manual restart: `pkill -f "tsx src/serve.ts"` then `cd apps/host && npm start`.
  The web is served from `apps/web/dist` — rebuild (`npm run build` in apps/web) and
  reload the browser to see web changes.
- Stray files in the repo root: `nav-check.png`, `topbar.png` (untracked, pre-date
  this session) and a `.playwright-mcp/` dir of snapshots from debugging — safe to
  delete.

## Verify

- web: `cd apps/web && npm run build && npm test` (expect 75 passing)
- host: `cd apps/host && npm run typecheck && npm test` (expect 40 passing)
- outliner: `cd packages/outliner && npm test` (expect 58 passing)

## Memory

Saved this session: never use `claude -p` ([[no-claude-dash-p]]); banned phrase
([[banned-phrase-meaty-one]]). See `MEMORY.md` for the full index.
