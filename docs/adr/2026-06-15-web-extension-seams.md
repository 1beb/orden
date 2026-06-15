# ADR-0017: Web extension seams — registration tables over switches

**Date:** 2026-06-15
**Status:** accepted

## Context

Three cross-cutting concerns in `apps/web/src/main.ts` had each grown into logic
spread across multiple call sites, so adding the next case meant editing several
places in lockstep:

- **Center views** were wired in three spots per view — `.active` CSS toggles, a
  breadcrumb `switch`, and annotator-teardown guards — across two
  `viewStore.subscribe` closures. Adding a view (a future team dashboard or
  org-admin panel) meant touching all three and hoping none was forgotten.
- **Vault-change reactions** (the multiplayer-sync backbone — every remote write
  by an agent, a host reactor, or eventually another user arrives as a `(ns, key)`
  change) lived in one growing `switch` with ~10 cases.
- **Settings controls** each repeated the same read-into-control + write-through +
  optional-refresh block (~9 copies).

Separately on the host, the destructive-git guardrail existed as **two
hand-maintained copies** — the claude PreToolUse hook and the generated opencode
plugin — which had already drifted once (the plugin's whole-string safe-list
negation let `git stash list && git stash` through while the hook blocked it).

`AGENTS.md` already described these as "extension seams" aspirationally, ahead of
the code. The enterprise-readiness review
(`docs/plans/2026-06-11-code-review-enterprise-readiness.md`) ranked extracting
them as its top-two highest-leverage actions, because every multi-user/org feature
adds entries to exactly these structures. This decision makes the code match the
documented contract.

## Decision

**Express each extension point as a registration table with a contract, and apply
the cross-cutting rules from one dispatcher that reads the table.** Adding a case
is a registration, never an edit to a switch or closure. Same philosophy as the
pluggable chat harness (ADR-0012) and the MCP tool bus (ADR-0008).

Shipped seams:

- **View registry** (`apps/web/src/viewRegistry.ts`). Each center view registers
  ONE self-describing `ViewSpec` (DOM section `el`, `breadcrumb`, `annotatable` /
  `textRealm` / `imageRealm` flags, `keepsHtmlToggle`, `navLinks`, `onEnter`).
  `createViewRouter` is the single `viewStore` subscriber: it toggles section +
  nav-link `.active`, drives the `no-panel` / `source-view` / `has-outline` flags,
  paints the breadcrumb, hides the html toggle, tears down annotators by realm,
  runs the view's `onEnter`, re-gates the source-send button, persists `last-view`,
  and closes the mobile drawer. `register` throws on a duplicate view.

- **Vault-change router** (`apps/web/src/vaultChangeRouter.ts`). One handler per
  namespace (files, pages, cards, learnings, projects, docs, settings, sessions,
  feedback, ui); the single `onVaultChange` subscriber just dispatches. `register`
  throws on a duplicate namespace. Unregistered namespaces (e.g. `chat:<id>`,
  which has its own subscriber) are deliberately ignored.

- **Settings binders** (`apps/web/src/settingsBindings.ts`).
  `bindCheckbox` / `bindSelect` / `bindRadios`, each taking an optional `onChange`
  that runs after the cached save so dependent refreshes read the new value. The
  key argument is typed so a binder can't be pointed at a wrong-shaped setting.

- **Shared destructive-git guard** (`apps/host/src/destructiveGit.ts`). The
  patterns and denial text live in ONE place; the claude hook imports them and the
  generated opencode plugin (`apps/host/src/opencodePlugin.ts`, extracted from
  `terminal.ts`) embeds them via `destructiveGitArrayLiteral()` at generation
  time. `destructiveGit.test.ts` runs one command corpus against BOTH consumers,
  so the two can never drift apart again.

The contracts (throw-on-duplicate, one-handler-per-key, one-corpus-both-consumers)
are deliberate: collisions fail loud at boot, not silently at runtime.

This is behavior-preserving groundwork, not a user-facing feature. The seam files
predated this decision in `AGENTS.md`; this records the decision and brings the
code in line with it.

## Consequences

**Easier:**

- New center views (team dashboard, org-admin) are one `viewRegistry.register`
  call; the router applies every cross-cutting rule, so a new view can't forget
  one.
- New shared-state namespaces (presence, locks, org scoping) are one
  `vaultChangeRouter.register` call.
- When settings later split into org / project / user scopes, the scope
  resolution lands in the binders, not in every call site.
- The destructive-git guard cannot diverge across agents; a new dangerous command
  is one pattern + one corpus row, covered everywhere at once.

**Harder:**

- More indirection than a strictly single-user app needs — the view registry in
  particular is a table where there used to be a closure. The bet is that
  multi-user/org features are coming and will add rows; if that direction stalled,
  the registry is overhead.
- The router runs every rule on every transition from data, so a per-view
  exception (should one ever be needed) must be expressed as a spec flag rather
  than an inline `if`.

## Follow-ups

- `AGENTS.md` still references a `makeViewToggler` for overlay views (settings,
  help) that does not exist — the return-to-prior-view logic is inline
  (`preSettingsView` / `preHelpView`) in `main.ts`. Either extract it as a fourth
  overlay-view seam or correct the doc; tracked separately from this ADR.
