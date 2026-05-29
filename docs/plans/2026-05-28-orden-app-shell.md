# Orden App Shell Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (or superpowers:subagent-driven-development in-session) to implement this plan task-by-task.

**Goal:** Take the orden web app from a single hardcoded review document to a real, dogfoodable workspace: multiple central views (Journal outliner, Kanban, Document review), a working left nav, persisted settings with a startup preference, real project files opened from the repo, and durable annotations that survive reload.

**Architecture:** `apps/web` is the orden app: a three-pane shell (left nav · center · right session). The center hosts swappable **views** behind a small view controller. The Document-review view is the existing, locked annotation core (do not alter its internals). The Journal view is a ProseMirror outliner; the Kanban view renders the `@orden/outliner` board model. Pure logic (file source, settings store, persistence, view state) is framework-agnostic and TDD'd; view wiring is verified by running the app. `@orden/annotation-core` and `@orden/outliner` stay standalone, zero-coupling packages consumed via alias.

**Tech Stack:** TypeScript, Vite, ProseMirror (model/state/view/markdown/schema-list/inputrules/keymap/commands/history), Vitest, happy-dom. Consumes `@orden/annotation-core` and `@orden/outliner`.

**Current state (already built — do not redo):**
- `packages/annotation-core` — standalone: annotation model, text-offset/quote helpers, `createAnchor`/`resolveAnchor` (context-disambiguated, orphan-on-miss), `MemorySink`/`sendFeedback`. 18 tests. **Locked.**
- `packages/outliner` — standalone: block-tree model + ops, markdown round-trip, page/journal model, `[[wiki link]]`+backlinks, Kanban model + `renderBoard`. 57 tests. Not yet consumed by the app.
- `apps/web` — three-pane shell; PM markdown editor with the `annotation` mark; annotate flow (selection pill → composer → Save); document-ordered panel + collapsible **Outline**; annotation states (open/sent/resolved/orphaned); feedback payload preview + Copy; collapsible sidebars + Recent list (static); markdown input rules; responsive/mobile layout (drawer + bottom sheet + pinned send bar). Hardcoded sample doc, in-memory log, no persistence, nav items inert.
- `apps/web/src/pm-reanchor.ts` — drafted PM-side quote re-anchor matcher, not yet wired (used in Phase F).

---

## Conventions

- Commit per task; short messages; **no AI attribution**; never `git add .` — stage named files.
- TDD the pure logic (Vitest). For view/UI tasks, the "test" is running the app and observing (use the running Vite server + a browser); state the acceptance check explicitly.
- The Document-review view (editor + annotations panel + action bar) is **locked** — only the *shell around it* changes.
- Keep `@orden/annotation-core` and `@orden/outliner` free of app-specific or cross-package imports.

---

## Phase A — Workspace + view controller foundation

### Task A1: Adopt an npm workspace

**Files:** Create `package.json` (root); Modify `apps/web/package.json`, `apps/web/vite.config.ts`, `apps/web/tsconfig.json`.

- Root `package.json`: `{ "name": "orden", "private": true, "workspaces": ["packages/*", "apps/*"] }`.
- `apps/web` depends on `"@orden/annotation-core": "*"` and `"@orden/outliner": "*"`.
- Keep the Vite `resolve.alias` + tsconfig `paths` for both packages (point at each package's `src/index.ts`) so dev needs no build step.
- `npm install` at root.

**Acceptance:** `cd apps/web && npm run dev` serves; `npm run typecheck` clean; importing from `@orden/outliner` resolves.

**Commit:** `adopt npm workspace; web consumes outliner`

### Task A2: View state module (TDD)

**Files:** Create `apps/web/src/viewState.ts`; Test `apps/web/test/viewState.test.ts` (add Vitest + happy-dom to apps/web devDeps + a `vitest.config.ts` mirroring annotation-core).

A pure, framework-agnostic store for the active center view.

```ts
export type View = "review" | "journal" | "kanban";
export interface ViewStore {
  get(): View;
  set(v: View): void;
  subscribe(fn: (v: View) => void): () => void;
}
export function createViewStore(initial: View): ViewStore { /* listeners Set, get/set/notify */ }
```

Tests: initial value; `set` notifies subscribers; `unsubscribe` stops notifications; setting the same value still notifies (or document chosen behavior).

**Commit:** `add view-state store`

### Task A3: Restructure the center into a view host

**Files:** Modify `apps/web/index.html`, `apps/web/src/styles.css`, `apps/web/src/main.ts`.

- Wrap the existing review layout: `#app` middle column becomes `#center`, containing three siblings — `#view-review` (the current `#main` with doc-pane + panel, **unchanged internally**), `#view-journal`, `#view-kanban`. Only the active one is shown (`.view { display:none } .view.active { display:… }`).
- `#center` is the grid item (column 2): `min-width:0; min-height:0; overflow:hidden`. Each view fills it.
- Move the responsive rules that targeted `#main` to target `#view-review`'s inner grid as needed; verify mobile drawer/sheet still work for the review view.
- Wire `createViewStore("review")` in `main.ts`; subscribe → toggle `.active`; default still review so nothing visibly changes yet.

**Acceptance:** App looks identical to now; switching the store value in the console shows/hides empty journal/kanban containers.

**Commit:** `center view host with review/journal/kanban containers`

---

## Phase B — Journal view (Logseq-style outliner, today's date)

### Task B1: Journal outliner editor

**Files:** Create `apps/web/src/journal.ts`; Modify `apps/web/src/main.ts`, `styles.css`.

- Build a ProseMirror editor configured as an outline: schema = markdown schema (bullet_list/list_item/paragraph), the input rules and list keymap we already have (`-`/`1.`, Tab/Shift-Tab, Enter splits items). Reuse `apps/web/src/inputrules.ts`.
- Render into `#view-journal`: an `<h1>` today's date (via `@orden/outliner` `journalKey(new Date())` for the key/title) followed by the outliner, seeded with one empty bullet.
- Per-day documents keyed by `journalKey(date)`; for now hold them in memory (persistence in Phase F).

**Acceptance:** With the store set to `journal`, the center shows "Journal — <today>" and an editable bullet outline; Tab/Enter behave like an outliner.

**Commit:** `journal outliner view with today's date`

### Task B2: Nav wiring — Journal/Kanban/Recent switch views

**Files:** Modify `apps/web/src/main.ts`, `index.html`.

- Click **Journal** → `viewStore.set("journal")` (today's date). Click **Kanban** → `set("kanban")`. Click a **Recent** file or session → `set("review")` and load that doc (full load in Phase E; for now switch to review).
- Maintain a single `.active` nav item reflecting the current view; update on view change.
- On mobile, switching view also closes the nav drawer.

**Acceptance:** Clicking Journal swaps the center to the outliner; clicking a recent file returns to the review doc; active nav item tracks the view.

**Commit:** `wire left-nav items to view switching`

### Task B3 (optional, later): bridge journal to `@orden/outliner`

Extract `[[links]]`/backlinks and block ids using the package; serialize the journal to/from markdown via the package's `toMarkdown`/`fromMarkdown`. Defer until persistence (Phase F) is in.

---

## Phase C — Kanban view

### Task C1: Render the board from the model

**Files:** Create `apps/web/src/kanban.ts`; Modify `main.ts`, `styles.css`.

- Use `@orden/outliner` `buildBoard(cards)` + `renderBoard(...)` to render into `#view-kanban`. Seed mock cards spanning the lifecycle (backlog→complete + broken).
- Style columns to match the app (light theme); show per-column counts and the needs-action badge; the nav Kanban badge uses `needsActionCount`.

**Acceptance:** Store set to `kanban` shows columns in lifecycle order with mock cards and a needs-action badge that matches the nav badge.

**Commit:** `kanban board view from outliner model`

### Task C2 (later): cards as Session projections

Replace mock cards with real Session objects once a Session store exists (deferred infra). Note in code where this hooks in.

---

## Phase D — Settings + startup preference

### Task D1: Settings store (TDD)

**Files:** Create `apps/web/src/settings.ts`; Test `apps/web/test/settings.test.ts`.

```ts
export type StartupView = "journal" | "kanban" | "last";
export interface Settings { startup: StartupView; }
export function loadSettings(): Settings;          // localStorage "orden:settings", default { startup: "last" }
export function saveSettings(s: Settings): void;
```

Tests (mock localStorage / inject storage): default when empty; round-trip; tolerate malformed JSON (return default).

**Commit:** `add settings store with startup preference`

### Task D2: Settings cog + popover (bottom-left)

**Files:** Modify `apps/web/index.html`, `styles.css`, `main.ts`.

- Make `#leftnav` a flex column: a scrollable `.nav-scroll` (current nav content) + a pinned `.nav-footer` holding `#settings-cog` (⚙) in the **bottom-left**.
- Cog toggles a small popover anchored bottom-left: title "Settings", group "On startup, show" with three radios — **Journal / Kanban / Last document** — reflecting and writing `settings.startup` immediately. Close on outside click / Esc.
- Update `applyLayout` to reparent the Outline into `.nav-scroll` (not after the footer) on mobile.

**Acceptance:** Cog opens the popover; choosing an option persists across reload (verify the radio reflects the saved value).

**Commit:** `settings cog and startup-preference popover`

### Task D3: Honor the startup preference on load

**Files:** Modify `apps/web/src/main.ts`.

- On boot: `journal`→`set("journal")`; `kanban`→`set("kanban")`; `last`→`set("review")` and load the last-opened document (persist last-doc id in Phase E; until then default to the sample/most-recent).

**Acceptance:** Set startup to Journal, reload → app opens on the Journal outliner. Set to Last → opens the review doc.

**Commit:** `route initial view from startup preference`

---

## Phase E — Open the orden project, in orden (dogfooding)

### Task E1: Repo file source

**Files:** Create `apps/web/src/files.ts`; Modify `apps/web/vite.config.ts`.

- Expose the repo's docs as openable files. Use Vite `import.meta.glob` with `{ query: "?raw", import: "default", eager: true }` over the repo's markdown (e.g. `../../docs/**/*.md`, `../../*.md`). Set `server.fs.allow` to include the repo root so Vite serves files two levels up.
- `files.ts` exports `listFiles(): {path,title,content}[]` and `getFile(path)`. Title = first `# heading` or basename.

**Acceptance:** `listFiles()` returns the design doc + the plan docs with their real content.

**Commit:** `repo file source via import.meta.glob`

### Task E2: Real Recent list + open into review

**Files:** Modify `apps/web/src/main.ts`, `index.html`.

- Populate the Recent nav list from `listFiles()` (replace the static entries). Clicking one: `set("review")`, parse its markdown into the review editor (`markdownParser.parse`), reset the annotation log for that doc, re-render. Update the top-bar doc title.
- Persist the last-opened file path (`orden:last-doc`) so `startup: "last"` reopens it.

**Acceptance:** The Recent list shows `2026-05-28-orden-design.md`, the plan docs, etc.; clicking one opens it in the editor and you can annotate it. "Open the orden project, in orden" works.

**Commit:** `open real repo docs in the review editor`

---

## Phase F — Persistence + reload (folds in the old "Phase 2")

### Task F1: Persist doc markdown + annotation log

**Files:** Create `apps/web/src/persist.ts`; Test `apps/web/test/persist.test.ts`; Modify `main.ts`, `apps/web/src/store.ts` (add `load(records)`).

- `saveState(key, markdown, records)` / `loadState(key)` keyed per document path (so each opened doc keeps its own annotations). localStorage-backed; tolerate malformed data.
- Serialize the review doc via `markdownSerializer` (already drops the annotation mark → clean markdown). Save on change (debounced).

Tests: round-trip; missing key → empty; malformed → empty.

**Commit:** `persist document markdown and annotation log`

### Task F2: Cold-start re-anchor

**Files:** Modify `apps/web/src/main.ts`; uses existing `apps/web/src/pm-reanchor.ts`.

- On opening a doc: load its persisted log; for each record, `reanchorQuote(doc, quote)` → if found, re-apply the `annotation` mark over the range; if not, leave it (renderPanel already shows log records absent from the doc as **orphaned**).
- Remove the dev seed once persistence drives content (keep behind a "no persisted state" fallback or drop).

**Acceptance:** Annotate a doc, reload → highlights restored in place; edit a quoted span away, reload → that one orphans (badge), the rest restore; never mis-anchors.

**Commit:** `cold-start re-anchor of annotations from quotes`

---

## Phase G — Send feedback through the sink seam

### Task G1: Real sink (localStorage outbox now, MCP later)

**Files:** Create `apps/web/src/sink-local.ts`; Modify `main.ts`.

- `LocalStorageSink implements SinkAdapter` (from `@orden/annotation-core`): `send(batch)` appends `{ at, target, items }` to `orden:feedback-outbox`.
- On **Send feedback**: set each open annotation's `target = feedbackTarget`; `await sendFeedback(sink, openItems)`; mark them `sent` in the log; persist; still show the payload preview.

**Acceptance:** Send feedback marks items Sent (bar → Approve), persists across reload, and the outbox accumulates the batch. The seam is ready to swap `LocalStorageSink` for an MCP sink with no UI change.

**Commit:** `wire send-feedback through annotation-core sink to a local outbox`

---

## Deferred (separate plans; design doc "Engine/Transport/Execution")

These need infra and a backend; not in this plan:
- Sessions hosted in tmux (local + `ssh`), lifecycle state machine, Card↔Session projection.
- MCP message bus (`open_in_main_view`, state transitions, stuck/broken); the right pane wired to a live session; structured-transcript adapters (CC JSONL tail / opencode store).
- SFTP file I/O over ssh for remote docs; git worktree per session.
- Evidence slot (re-runnable writeup + optional verifier hook); off-device notifications.
- Real-time collab (Yjs + y-prosemirror).
- Backlog: rearrangeable outline/annotations layout; nested-block matcher fix in annotation-core's `resolveAnchor` (`#18`).

## Done criteria for this plan

- Left nav switches the center between **Journal** (today's outliner), **Kanban**, and **Document review**.
- A **settings cog** (bottom-left) sets the **startup view** (Journal / Kanban / Last document), persisted.
- The **orden repo's own docs open in orden** from a real Recent list, and can be annotated.
- Annotations **survive reload** (re-anchored from quotes; orphans badged, never mis-anchored).
- **Send feedback** flows through the annotation-core sink seam to a persistent outbox.
- `annotation-core` and `outliner` remain standalone; all packages typecheck and tests pass.
