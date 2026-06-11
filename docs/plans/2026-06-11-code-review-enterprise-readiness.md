# Code review: modularity refactors for the Path A → Path B transition

Captured 2026-06-11. A systematic review of the current codebase, filtered through
the lens of the two sequencing docs:

- `2026-06-09-go-to-market-design.md` (Path A — single-user v1 sale)
- `2026-06-09-how-to-sell-to-enterprise.md` (Path B — enterprise build-list)
- `2026-06-10-team-path-sequencing.md` (bridge strategy)

The standing constraint from the team-sequencing doc: **"protect the vault schema
— sessions, cards, documents, and annotations are already the objects a team
version would share. Keep them clean and share-shaped, and the team product stays
a refactor instead of a rewrite."**

This document names the refactorings that serve both immediate code quality and
the enterprise transition, and distinguishes them from cosmetic changes that
carry no path risk.

Independently re-verified 2026-06-11 against main (which already carries further
uncommitted changes). Corrections from that pass are integrated inline: the
vault-change case count, the opencode plugin's actual size, the discovery that
the duplicated destructive-git guard is already *behaviorally divergent* (not
just a drift risk), and a namespace-scoping nuance in the vault section.

---

## What the Host interface already gets right

The `Host` interface (`packages/host-api/src/index.ts`) has the right seams:

- `Identity` — exists, single-user no-op today, becomes real auth in Path B
- `LockService` — exists, stubbed, becomes pessimistic doc locking in teams
- `VaultStore` — `(ns, key)` API, already a multi-tenant shape
- `ProjectRegistry`, `SessionManager`, `FileSource` — interface-based, swappable

The risk is not in the interface. It is in the concrete code that sits on top
of it and would need to absorb multi-tenancy, presence, permission gates, and
org-scoped data without collapsing under its own weight.

---

## Problem 1: `apps/web/src/main.ts` is 2,308 lines of mixed concerns

(2,349 on main as of 2026-06-11 — it grew 41 lines while this review was being
written, which is the problem demonstrating itself.)

This file is the application nexus. Every enterprise feature lands here:
presence updates, permission-gated views, org-scoped change feeds, team admin
panels. Today it is a single module doing all of the following:

| Concern | Lines | Should live in |
|---------|-------|---------------|
| All settings form wiring (accent, font, panel width, 7 checkboxes, mode grid, timezone, etc.) | ~525 | `settings.ts` or `settingsBindings.ts` |
| Image region-annotation drag-to-create (mousedown/move/up, draft box, composer, resize) | ~164 | `imageAnnotator.ts` |
| Review document loading (loadReviewDoc, ProseMirror transaction, re-anchoring) | ~37 | `reviewDoc.ts` |
| Annotation panel rendering (buildRow, renderPanel, syncHighlights, delete, resolve) | ~163 | `annotationPanel.ts` |
| Omnisearch sources and command palette commands (5 search sources, 10+ commands) | ~135 | `commandPalette.ts` or `searchConfig.ts` |
| Breadcrumb rendering (renderBreadcrumb, updateBreadcrumb, fileCrumbs) | ~79 | `breadcrumb.ts` |
| HTML doc-map rendering (renderDocMap, renderHtmlDocMap) | ~38 | `docmap.ts` |
| Layout/responsive logic (syncPanelSheet, wireFurl, wireHideShow, syncPanelColumn, focus mode, viewport pinning) | ~186 | `layout.ts` |
| Source annotation delivery (openAnnotatableText, sendSourceAnnotations, teardown hooks) | ~77 | `sourceAnnotation.ts` |
| View routing (viewStore.subscribe handler — the de facto view router) | ~40 | `viewRouter.ts` |
| Vault change feed handler (7-case switch block — the multiplayer sync backbone) | ~116 | `vaultChangeRouter.ts` |

**~1,200 lines can be extracted into ~10 focused modules.** After extraction,
`main.ts` would be ~1,100 lines: hydration bootstrap, DOM query wiring, and
delegation to modules.

### Why this matters for enterprise

The vault-change handler (`onVaultChange`, lines 2170–2286) is the multiplayer
sync backbone. In a team product, this is where shared state arrives — another
user's annotation, a colleague's card move, a presence update. Today it is an
inline closure with **10 cases** (`files`, `pages`, `cards`, `learnings`,
`projects`, `docs`, `settings`, `sessions`, `feedback`, `ui`). Enterprise adds
`presence`, `locks`, `org`, and per-tenant scoping. If this stays in `main.ts`,
it becomes the bottleneck.

The view routing is where permission-gated views, team presence overlays, and
org-scoped panels get injected. Today it is **two separate
`viewStore.subscribe` closures** (~1392 and ~1432 on main) — one toggling CSS
classes and calling render functions, one handling teardown — so the de facto
router is already split across two subscribers that must stay in agreement.
Enterprise needs a view registry where each view registers `onEnter`/`onLeave`
hooks, and a single router dispatches; the registry must absorb both closures,
not just the first.

**Recommended action:** pull the vault-change handler and view routing out of
`main.ts` first. These are the two subsystems that every enterprise feature
touches. If they are clean dispatch tables when Path B work begins, the features
are additions. If they stay in a 2,300-line closure, they are surgery.

---

## Problem 2: The view routing uses switch/case as a poor man's dispatch table

Two places in `main.ts` use switch on `View` where a table would be clearer and
extensible:

1. `updateBreadcrumb()` (lines 1150–1184) — 35 lines, 10 cases
2. The two `viewStore.subscribe` closures (~1392 and ~1432 on main) — mixed
   concerns, and the routing decision is split across both

Adding a new view (e.g. `"org-admin"` or `"team-dashboard"`) requires editing
both switches and remembering to add the CSS toggle, the breadcrumb case, the
teardown guard, and the panel visibility rule. A `viewRegistry` table makes each
view self-describing:

```ts
// Each view registers once, not spread across three switch blocks
viewRegistry.register("org-admin", {
  breadcrumb: () => [{ label: "Admin" }],
  onEnter: () => { /* show admin panel */ },
  onLeave: () => { /* tear down */ },
  annotatable: false,
});
```

**Recommended action:** replace both switches with a `viewRegistry` table. This
is a mechanical refactor with zero behavioral change.

---

## Problem 3: The opencode plugin lives as a JavaScript string literal in TypeScript

`terminal.ts:255-305` contains a ~50-line JavaScript program
(`opencodePluginSource()`) as a raw TypeScript string. The plugin handles:

- Session lifecycle events (created, idle, updated) → hook posts
- Destructive git guardrail (tool.execute.before)
- Tool execution tracking

Enterprise needs org-wide agent policy — which tools are allowed, spending caps,
credential injection, transcript redaction — all of which touch the agent launch
path. A raw string literal is impossible to compose or extend without string
concatenation.

Additionally, the destructive-git regex is defined in **two places**:

- `hooks.ts:118-123` — the server-side `DESTRUCTIVE_GIT` array
- `terminal.ts:291-294` — inline regex in the plugin source string

Same semantic check, two separate copies, no single source of truth — and the
copies have **already diverged behaviorally**. The `git stash` guard differs in
structure: `hooks.ts` uses a per-position negative lookahead
(`/\bgit\s+stash\b(?!\s+(?:list|show|pop|apply|branch|drop))/`), while the
plugin tests `/\bgit\s+stash\b/` and then negates a *whole-string* match
against the safe subcommands. Any innocent `git stash list` anywhere in a
compound command defeats the plugin's negation. Verified:

| Command | claude hook (`hooks.ts`) | opencode plugin |
|---------|--------------------------|-----------------|
| `git stash list && git stash` | **blocked** | **allowed** |
| `git stash; git stash list` | **blocked** | **allowed** |
| `git stash list` | allowed | allowed |

So an opencode session in a shared checkout can sweep up other sessions' dirty
state with a command the claude-side guard would have denied. This is no longer
a drift *risk* — it is a live inconsistency in the exact guard the worktree
isolation design depends on for the shared-checkout case. Enterprise policy
means *more* guards like this, not fewer.

**Recommended action:** make the plugin a real `.js` file (or a template function
that accepts policy parameters) rather than a raw string. Move the destructive-git
patterns to a single shared constant imported by both `hooks.ts` and the plugin
generator, with the lookahead semantics (the stricter of the two), and a test
that exercises both consumers against the same command corpus. This keeps the
blast radius of a guard change controlled.

---

## Problem 4: Settings form wiring repeats the same pattern 14 times

Every settings control in `main.ts` (lines 1936–2019) follows the same shape:

```ts
const cb = document.querySelector<HTMLInputElement>("#some-id");
if (cb) {
  cb.checked = loadSettings().someSetting;
  cb.addEventListener("change", () => {
    void saveSettings({ someSetting: cb.checked });
    // optionally refresh something
  });
}
```

This pattern appears 7 times for checkboxes alone (showArchived, sessionAutoLaunch,
worktreeIsolation, htmlRender, showScratchTerminal, and 2 more in the settings
view). Sliders and selects add 7 more. A generic `bindSetting` helper would cut
~80 lines:

```ts
function bindCheckbox(id: string, key: keyof Settings, onChange?: () => void) { ... }
```

If settings split into org-level, project-level, and user-level scopes (the
enterprise doc doesn't say this literally, but its "org-wide agent policy" and
"policy engine" items imply settings that resolve across scopes), the current
inline pattern means every binding must be touched. A generic binder localizes
the scope concern.

**Recommended action:** extract a `bindSetting`/`bindCheckbox`/`bindSelect`
helper. Low effort, immediate payoff, scales to scoped settings.

---

## Problem 5: "Toggle view" logic is duplicated for Settings and Help

`main.ts` (lines 1495–1665) has two identical toggle patterns:

```ts
// Settings
let preSettingsView: View = viewStore.get();
function toggleSettings() { ... toggle between settings and preSettingsView ... }

// Help — same shape
let preHelpView: View = viewStore.get();
function toggleHelp() { ... toggle between help and preHelpView ... }
```

Both are wired to Escape in a shared `keydown` listener. A `makeViewToggler`
factory collapses both into one pattern and makes adding a third overlay view
(`"org-admin"`, `"team-settings"`) a one-liner.

**Recommended action:** extract a `makeViewToggler(viewName, prefsKey)` factory.

---

## Problem 6: `refreshBoard()` + `refreshProject()` called as a pair 7+ times

Every mutation that touches sessions or cards calls both:

```ts
refreshBoard();
refreshProject();
```

This pair appears in the archive, remove, cleanup, and create-session callbacks,
and again in the vault-change handler's `"cards"` case. There is no single
`refreshAll()` or `refreshBoardAndProject()`. Adding a third refresh target
(team dashboard, org overview) would mean hunting every call site.

**Recommended action:** introduce a `refreshBoardAndProject()` (or a broader
`refreshCrossCutting()`) that encapsulates the pair.

---

## What does NOT need to change now

These were flagged in the raw review but carry zero enterprise path risk:

| Issue | Why it's fine to defer |
|-------|----------------------|
| Duplicated `el()`/`button()` helpers in `sessionsPanel.ts` and `chatView.ts` | Cosmetic. Chat-ui is a separate package and intentionally avoids importing from apps/web. A shared `@orden/dom-utils` is clean but not blocking. |
| `chatView.ts` (713 lines) being monolithic | Self-contained package with clear boundaries. It will grow with features — decomposition then vs now doesn't change the enterprise surface. |
| `tools.ts` (640 lines) being one file | MCP tools are already pure functions over Host; splitting into `tools/cards.ts` etc. is organizational, not architectural. |
| `projectPage.ts` (886 lines) | A single-view module with a clear boundary. It will need member lists and permission settings when teams arrive, but it's not a blocker. |
| `hooks.ts` (376 lines) subagent state machine | Well-documented, correct, and the logic is self-contained. Extracting it into a state-machine module would be nice but changes nothing for multi-tenancy. |

---

## The one structural risk worth watching now (not refactoring — awareness)

The vault namespace is flat: `"sessions"`, `"cards"`, `"pages"`, `"learnings"`,
`"projects"`, `"chat"`, etc. The `VaultStore` interface takes `(ns, key)` — two
levels. Enterprise multi-tenancy needs three: `(orgId, ns, key)`.

Today every store reads across all keys without a scope discriminator.
`list("sessions")` returns ALL sessions. In a single-user world, that is correct.
The day a second user is added, it returns their sessions too.

This is not a bug — it is the natural shape of single-user code. But it means
the vault layer will need a scoping boundary before multi-tenancy works. The
`VaultStore` interface itself can absorb this (a `ScopedVaultStore` wrapper)
without changing callers, as long as the interface is respected everywhere.
One nuance the wrapper must handle: namespaces are not a fixed set — chat
transcripts mint a namespace per session (`chat:<id>`), so the scope
discriminator has to prefix the *namespace*, not just keys, or pattern-match
dynamic namespaces. Still a single adapter class, but key-prefixing alone is
not enough.

The risk is code that bypasses the interface to reach storage directly — none
was found in this review (re-verified independently: no fs access to vault data
outside `DiskVault` in `apps/host`; worktrees and opencode-plugin dirs live
beside the vault but are not vault data).

**Recommendation:** audit for any code that reads or writes vault data outside
the `VaultStore` interface before Path B begins. If none exists (the current
state), the scoping migration is a single adapter class.

---

## What Path A (the v1 sale) needs from the same seams

Added 2026-06-11 after reading the go-to-market doc against this review: the
original pass filtered only through the Path B lens, but Path A's v1 scope has
code-path implications too, and they land on the same seams flagged above.

- Transcript import is the day-1 centerpiece: glob
  `~/.claude/projects/<encoded-path>/*.jsonl`, curate, and materialize the
  board and journal from history. That is a bulk write of sessions and cards
  into the vault — every one of which flows through the vault-change handler
  (Problem 1) and the board/project refresh pairs (Problem 6). Importing a
  heavy user's history will hammer an inline 10-case closure that re-renders
  per change; the router extraction is where batching/coalescing would live.
- The import/onboarding flow is a new first-run surface. Built before the
  extractions, it lands in `main.ts` and the file grows again; with the view
  registry (Problem 2) in place first, onboarding is a registered view.
- Archive treatment for historical sessions touches the cards store and the
  board's column derivation — the same objects the team-sequencing doc says to
  keep share-shaped. Import should write through the existing stores, not grow
  a parallel path.
- First-run doctor checks (claude on PATH, tmux, node-pty builds) and the
  kill-test (host dies mid-session, relaunch recovers) live in the host
  startup path (`serve.ts`) and the idle reconciler — self-contained, no
  conflict with the refactorings here.

So the sequencing argument is stronger than "do items 1–2 before Path B":
items 1, 2, and 6 pay off before the v1 import work, because import is the
first feature that stresses those seams at volume.

---

## Prioritized action list

Ordered by enterprise-path impact per unit of effort:

| # | Refactoring | Effort | Enterprise impact | Why |
|---|------------|--------|-------------------|-----|
| 0 | Unify the destructive-git guard behind one shared constant + corpus test | Low | **n/a — do now** | Not preventive anymore: the two copies already disagree (`git stash list && git stash` is blocked for claude, allowed for opencode). A correctness fix for today's single-user product, independent of any path |
| 1 | Extract vault-change handler from `main.ts` into `vaultChangeRouter.ts` | Medium | **High** | Multiplayer sync backbone; every team feature adds entries here (10 cases today and counting) |
| 2 | Replace view switches with a `viewRegistry` table (absorbing BOTH subscribe closures) | Medium | **High** | Adding team/admin views becomes registration, not surgery |
| 3 | Make opencode plugin a real file (template function), not a string literal | Medium | **Medium** | Agent policy, credential injection, audit all touch the launch path; also what makes item 0's single source of truth importable |
| 4 | Extract settings bindings into `bindSetting`/`bindCheckbox` helpers | Low | **Medium** | Settings split into org/project/user scopes; generic binder localizes the scope concern |
| 5 | Extract `makeViewToggler` factory for Settings/Help toggle pattern | Low | **Low** | Small win now; makes adding overlay views trivial later |
| 6 | Introduce `refreshBoardAndProject()` to replace the 7+ call-site pairs | Low | **Low** | Mechanical; prevents hunting call sites when a third refresh target appears |
| 7 | Extract remaining ~800 lines from `main.ts` (image annotator, annotation panel, breadcrumb, docmap, layout, review doc loader, omnisearch config) | Medium–High | **Medium** | These are independent modules today; extracting them shrinks `main.ts` to its actual job (bootstrap + delegation), making the enterprise additions in items 1–2 cleaner |

Item 0 is a bug fix and should land regardless of path decisions. Items 1–3
are the ones to do before Path B work begins — and items 1–2 stand on plain
code-quality grounds even if Path B never happens, so they are not speculative.
Items 4–7 improve the codebase now and make 1–3 easier, but their enterprise
payoff is secondary.

---

## What "done" looks like for `main.ts`

After these refactorings, `main.ts` should be:

1. Hydrate all stores at boot (`hydrateAll`)
2. Wire DOM queries to their owning modules
3. Create the view registry and register each view
4. Wire the vault-change feed to the router module
5. Wire keybindings to registered actions
6. Bootstrap the initial view from the startup preference

That is ~400 lines of glue — down from 2,308. Each extracted module is
independently testable, and the enterprise features (presence, permissions,
org scoping) are additions to the registry and router, not edits to a
sprawling file.
