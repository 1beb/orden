# AGENTS.md

Shared project context for AI coding agents working in this repository. opencode
reads this file directly; Claude Code reads it through the `CLAUDE.md` symlink.

## What orden is

Orden is a single-user web app for **operating AI coding agents at the level of
intent, planning, and review — not code**. You author in a markdown outliner, turn
any outline block into a live Claude Code / opencode session, let it plan and work in
isolation, then review its output by *reading a rendered writeup and annotating it
inline* rather than reading diffs. Your annotations flow back to the running agent.

The core loop, end to end:

1. Write a task as a block in the **Journal** (the daily outliner).
2. Spawn a **session** (an agent run) from it, scoped to a **project** (a local or
   remote working directory the agent runs in).
3. The agent plans, works autonomously in isolation, and parks a **document** (a
   rendered md/html/qmd/ipynb writeup — a plan or a review) for you.
4. You read it in the **main panel** and attach **annotations** (feedback anchored to
   text ranges); they're delivered back into the agent's live pane.
5. Each session is a **card** on the **Kanban board**, positioned by its lifecycle
   state (`planning` / `in-progress` / `blocked` / `complete`).

Two human touchpoints — approve the plan, review the evidence — with agent autonomy in
between. Orden's own generated structure (Journal, Pages, annotations, cards, sessions)
lives in the **vault**, not scattered through project folders. See
`docs/plans/2026-05-28-orden-design.md` for the full vision; every feature has a dated
design/impl doc in `docs/plans/`.

## UI surfaces and naming (shared vocabulary)

The web shell (`apps/web/index.html`) is **three columns**. Use these names in
conversation — they map to real DOM ids / modules, so we don't re-explain each time.

- **Left nav** / nav rail (`#leftnav`) — the brand, top links **Journal**, **Pages**,
  **Kanban** (with an action-count badge), a collapsible **Recent files** list, and the
  **Projects** section: each project expands to its nested **sessions**, with **+ Add
  project** (`projectModal.ts`). Footer has **Show outline** / **Show annotations**
  toggles, the **Settings cog** (⚙) popover, and the **help (?)** button (keyboard
  shortcuts). Built in `main.ts`; project rows in `projects.ts` / `sessions.ts`.
- **Topbar** (`#topbar`) — left **pane toggle** (⌘\\), the **view title**, an HTML
  source/render toggle, **omnisearch** (the "Search…" box), and the right pane toggle.
- **Main panel** / central view / "the main view" (`#view-area`) — the primary work
  surface and **the only pane an agent can drive** (over MCP via `panel_open`; the
  design doc calls it `open_in_main_view`). It's a stack of swappable views switched in
  `main.ts`: **`main`** (the ProseMirror doc editor / outliner), **`journal`**,
  **`pages`**, **`project`** (a project's descriptive **project page**, `projectPage.ts`),
  **`kanban`** (the **board**, `kanban.ts`), plus document viewers **`code`**, **`image`**,
  **`html`** (`codeView.ts`, `preview.ts`, `viewerSource.ts`).
- **Context panel** (`#panel`, the `aside` inside center) — the annotation rail that
  sits beside the main panel. Two blocks: **Outline** (the doc map / table of contents,
  `#docmap`) and **Annotations** (`annotationStore.ts` / `annotator-ui.ts`), with the
  **Send** / **Approve** / **Copy** actions. Toggled by the nav-footer Show buttons.
- **Right pane** / session pane (`#sessions`, `sessionsPanel.ts`) — the selected
  session's conversation. A status header (dot · name · state) over **two tabs**:
  **Terminal** (default — the agent's real TUI over xterm, `terminalView.ts`) and
  **Chat** (a structured transcript, `chatMount.ts`; only shown when the host has a chat
  backend). Both are **two views of one live session** — the same agent, mirrored.
- **Settings popover** (`settings.ts`) — startup view, fonts/accent, completed-task
  fade, session-pane width, autolaunch new sessions, render-HTML toggle, vault location.

**Keyboard shortcuts** route through `apps/web/src/keybindings.ts` — an action
registry (id + label + default chords) with vault-backed overrides (ns `settings`,
key `keybindings`) and ONE global dispatcher. Never add ad-hoc document-level
`keydown` listeners for shortcuts; register an action instead, so it shows up in the
help (?) view and stays user-rebindable there (`helpView.ts`). Chords are derived
from `KeyboardEvent.code` (layout-independent; Shift can't mutate the key token).
Defaults: `mod+\` nav, `mod+.` session pane, `mod+'` context panel, `mod+shift+\`
focus mode, `mod+k` search, `mod+shift+p` palette, `mod+/` or `?` help, `mod+,`
settings. While the terminal is focused, xterm yields only bound mod+punctuation /
mod+shift chords to the app (`terminalShouldYield` in `keybindings.ts`, wired via
`attachCustomKeyEventHandler` in `terminalView.ts`); `mod+letter` and bare keys stay
with the TUI.

**Web extension seams** (same contract style as keybindings — extend the table, don't
add a switch): center views register ONCE in the **view registry**
(`apps/web/src/viewRegistry.ts` — section el, breadcrumb, annotatable/realm flags,
nav link, `onEnter`); a single router subscriber applies the cross-cutting rules, so
never add a second `viewStore.subscribe` or a per-view `switch` in `main.ts`.
Vault-change reactions register per namespace on the **vault-change router**
(`apps/web/src/vaultChangeRouter.ts`) — one handler per ns, future shared-state
namespaces (presence, locks, org) are new registrations. Settings controls wire
through the binders in `apps/web/src/settingsBindings.ts`
(`bindCheckbox`/`bindSelect`/`bindRadios`), not hand-rolled query+listener blocks.
Overlay views that return to the prior view (settings, help) come from
`makeViewToggler` in `main.ts`.

Entity terms: **project** (a working dir, owns sessions), **session** (one agent run,
has a lifecycle state, hosted by a tmux/pty process), **card** (a session's projection
on the board), **document** (a rendered writeup attached to a session), **annotation**
(feedback anchored to a block id in a document), **page** (a vault doc), **vault** (where
all orden-generated structure persists).

## Commands

This is a pnpm workspace (`pnpm@11.5.0` required; 11.0.3 ignores the cooldown config).

```bash
pnpm -r test          # run every package's vitest suite
pnpm -r typecheck     # tsc --noEmit across all packages
pnpm --filter @orden/web build   # type-check + vite build apps/web → apps/web/dist
```

Per package (run from the package dir, or `--filter <name>`):

```bash
pnpm --filter @orden/host test            # one package's suite
pnpm --filter @orden/host exec vitest run path/to/file.test.ts   # a single test file
pnpm --filter @orden/host exec vitest run -t "name of test"      # a single test by name
```

After changes, run `pnpm -r typecheck` and the relevant `test` — the repo expects a
100% pass rate before moving on.

### Running the app locally

The host serves the web app from `apps/web/dist` (static, no HMR). To see web changes
you must rebuild. Run the host via tsx directly — `pnpm start` orphans the node child.

```bash
pnpm --filter @orden/web build                          # rebuild the bundle first
pnpm --filter @orden/host exec tsx apps/host/src/serve.ts   # then serve everything
```

Env knobs (see `apps/host/src/serve.ts`): `ORDEN_PORT` (default 4319),
`ORDEN_VAULT` (`~/.orden/vault`), `ORDEN_FILES_ROOT` (repo root), `ORDEN_WEB_DIST`,
`ORDEN_BIND`. By default it binds loopback **and** the tailnet IP only — never
`0.0.0.0` (no LAN/public exposure unless `ORDEN_BIND` says so).

### Dependency cooldown

`pnpm-workspace.yaml` sets `minimumReleaseAge: 43200` (only resolve versions ≥30 days
old, supply-chain safety) and blocks postinstall build scripts except `esbuild` and
`node-pty` (`onlyBuiltDependencies`). Adding a brand-new dependency version will fail
to resolve until it ages in; this is intentional.

## Architecture: the Host spine

The whole system pivots on one interface, `Host`, defined in
`packages/host-api/src/index.ts`. **The web app depends only on `Host`** — never on
Node, fs, or processes directly. `Host` bundles `identity`, `vault`, `projects`,
`files`, `sessions`, `locks`, optional `chat`/`terminalChat`, and `capabilities()`.
Read this file first; the surrounding doc comments are the source of truth for how
files watch, sessions spawn, and annotations deliver.

Two implementations satisfy `Host`:

- **BrowserHost** (`apps/web/src/host/browserHost.ts`) — in-browser, vault backed by
  browser storage, no remote projects or real agents (those capabilities are false
  and the methods no-op).
- **NodeHost** (`apps/host/src/nodeHost.ts`) — the full backend: `DiskVault` on disk,
  real filesystem files, and real claude/opencode agent processes.

`apps/web/src/host/selectHost.ts` picks between them by a single host-URL flag, so the
*same* UI runs as a pure web app or against a local/remote NodeHost. Location and
runtime are kept orthogonal to the UI.

### One process, one URL

`apps/host/src/serve.ts` is the single entrypoint. One HTTP server multiplexes:
`GET /` → static web bundle; WebSocket upgrades → the web UI's RPC + live change feed
(`/term` upgrades route to the agent PTY instead); `POST /mcp` → agents over MCP;
`/hooks/` → agent lifecycle hooks; `/repo-file/` → raw file bytes. The web↔host RPC
runs over WebSocket JSON-RPC (`apps/host/src/rpc.ts` + `wsTransport.ts`; browser-safe
re-exports in `apps/host/src/client.ts`, which deliberately excludes Node-only modules
so the browser bundle never pulls in `ws`/`node:fs`).

### Vault + change feed = reactive state

The vault is a **namespaced key-value store** (`VaultStore`: `get/set/list/delete` over
`(ns, key)`). It is the single source of truth for almost all app state — annotations,
pages, settings, kanban `cards`, `sessions`, chat transcripts (`chat:<id>`), etc. Every
write fires a change on `host.onChange((change) => …)` with `{ns, key}`. The host wires
several **reactors** off this feed (see `serve.ts`): launch-on-create (spawn an agent
when a session is flagged `pendingLaunch`), reap-on-complete (kill agents when a card
hits Done). On the web side, stores **hydrate from the vault at boot and write through**
it — there is no direct localStorage; `apps/web/src/main.ts` wires the hydration of
projects/pages/cards/sessions/annotations, and the change feed keeps views live through
the per-namespace handlers registered on `vaultChangeRouter.ts`.

### Agent sessions

`apps/host/src/nodeSessions.ts` spawns and resumes real Claude Code / opencode
sessions (tmux + `node-pty`; opencode via its serve HTTP+SSE API in
`opencodeSession.ts`). A session's transcript is parsed and mirrored into the vault so
the Chat tab and Terminal tab are two views of one live session (`TerminalChat` in
host-api; `apps/host/src/chat/`). Sessions are titled automatically
(`sessionTitles.ts`, `transcriptTitle.ts`).

**Worktree isolation** (design: `docs/plans/2026-06-10-session-worktree-isolation-design.md`):
a session of a local git project launches in its OWN git worktree
(`~/.orden/worktrees/<projectId>/<sessionId>`, beside the vault) on an
`orden/<slug>` branch, so no session can clobber a sibling's or the user's
uncommitted state. Gated by the "Isolate sessions in git worktrees" setting
(default on, per-project overridable); the worktree decision lives in
`resolveSessionCwd` (`terminal.ts`), the creation logic in `worktrees.ts`, and the
chosen `workdir`/`branch` persist on the session record as HOST_OWNED fields.
Completion publishes the branch (clean-check → push → PR per the prForge setting;
`publishSession.ts`, surfaced on the card) and never merges; pushed worktrees are
reaped (`cardReaper.ts`). In SHARED checkouts (isolation off / non-git),
destructive git (`reset --hard`, `checkout .`, `clean -f`, `stash`) is denied via
an injected PreToolUse hook (`hooks.ts`) and the generated opencode plugin
(`opencodePlugin.ts`). The patterns + denial text live in ONE place —
`apps/host/src/destructiveGit.ts` — and are embedded into the plugin at generation
time; `destructiveGit.test.ts` runs one command corpus against BOTH consumers, so
extend the corpus when touching the patterns. Note for THIS repo: with isolation
on, an agent's web changes only reach the served dist after merge + rebuild.

### Chat backend is modular (`packages/chat-core`)

The native Chat view is built on a **pluggable harness registry**. A `HarnessAdapter`
(claude or opencode) exposes models + an `open()` returning a `HarnessDriver` that
emits a single normalized `DriverEvent` stream. A generic engine
(`chat-core/src/engine.ts`) consumes any adapter and a `VaultReducer`
(`reduceToVault.ts`) folds events into the `chat:<id>` vault namespace, which the
web chat store renders live. **Adding a harness = one adapter file + widening the
`ChatHarness` union.** `packages/chat-ui` is the renderer over this model.

### MCP agent bus (`packages/mcp`)

Agents reach orden over MCP (`POST /mcp`, served by `handleMcpRequest`). Tools operate
the kanban and pages: `card_*`, `session_create`, `project_list`, `page_*`, `vault_*`,
`panel_open`, `annotation` delivery. Sessions bind per-conversation via `/mcp/<convId>`
(`parseSessionBinding`), so a tool call knows which card/session it belongs to. Connect
an external agent with `claude mcp add --transport http orden http://127.0.0.1:4319/mcp`.

**Rendering is host-owned, agent-driven.** Quarto always runs on the host, but the
agent drives it: edit the `.qmd`/`.md` source, call `doc_render({path})` (the host runs
quarto and returns `{ok, outputPath, errors}`), verify `ok`, then `panel_open(outputPath)`
to surface it. Two tools on purpose — `doc_render` only builds, `panel_open` only opens —
so the verify-then-open step stays an explicit gate (don't open a doc you haven't
confirmed rendered). Gated by `capabilities().docRender`.

**Kanban card-state semantics** (enforced across MCP tools and hooks):
`planning`=idle, `in-progress`=working, `blocked`=done-with-turn/waiting-on-user,
`complete`=user-only. `card_move` cannot reach `complete`; only `card_complete` can,
and only on the user's explicit say-so. The auto-cycle between states is driven by
agent **hooks** (`apps/host/src/hooks.ts`), not MCP, because MCP can't observe the
session lifecycle.

**Learnings on completion.** Right before `card_complete`, the completing agent distills
what the session changed into **learnings** via `learning_propose` — one per proposed
README/ADR/AGENTS.md edit or new skill, carrying the FULL post-change file content (not a
diff). They land in the `"learnings"` vault ns as `pending` and surface in a derived
**Learnings** kanban column (a `complete` card with pending learnings buckets there) and
the **learnings** review view, where the user accepts (writes the file), rejects, or
comments (sent back to the agent). A user **comment is a revise-signal**: the agent
re-runs `learning_propose` with that learning's `id` (and the full updated content),
which updates the proposal in place and returns it to `pending` for re-review — it does
not create a new learning. Not memories — README/ADR/AGENTS/skill only.

### Annotations (`packages/annotation-core`)

Rendered review docs (md/html/qmd/ipynb) get inline annotations anchored to **block
ids** assigned at render time (not coordinates), so they survive re-render. An
annotation carries a quote/blockId/note; `SessionManager.annotationSend` resolves the
card whose `planDoc` matches, finds the backing session, and types the rendered note
into the live agent pane (or relaunches a dead session with it queued). The web uses
ProseMirror for the outliner/editor (`apps/web/src/schema.ts`, `outlineEditor.ts`) and
the `@orden/outliner` package; on-disk owned HTML renders same-origin and is annotated
directly, external sites stay sandboxed.

## Workspace layout

- `apps/host` — NodeHost backend + the single serving process (`serve.ts`).
- `apps/web` — the UI (ProseMirror, xterm). Built to `dist`, served by the host.
- `packages/host-api` — the `Host` interface (the spine). Re-exports `chat-core` types.
- `packages/chat-core` — harness-agnostic chat engine + adapter registry + vault reducer.
- `packages/chat-ui` — chat renderer over the chat-core model.
- `packages/mcp` — the MCP server, kanban/page/vault tools, session binding.
- `packages/annotation-core` — block-id anchored annotation model + delivery rendering.
- `packages/outliner` — the outliner component.

## Gotchas

- **happy-dom `TreeWalker` with `SHOW_TEXT` skips text inside inline elements** — use a
  recursive walker in annotation-core code/tests, not the standard one.
- Web changes need a `dist` rebuild before the host serves them (no HMR).
