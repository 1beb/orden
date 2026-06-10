# ADR-0003: Vault as single source of truth with reactive change feed

**Date:** 2026-05-29
**Status:** accepted

## Context

Orden needs a place to persist all its own generated structure — journal entries,
pages, kanban cards, sessions, annotations, settings, chat transcripts — without
scattering files into project directories. The web UI must react instantly to
changes from the host (new cards, state transitions, file modifications).

## Decision

**Use a namespaced key-value vault (`VaultStore`) as the single source of truth
for all orden-generated state, with a reactive change feed.**

- `VaultStore` interface: `get/set/list/delete` over `(ns, key)`. Namespaces
  include `cards`, `sessions`, `projects`, `pages`, `annotations`, `settings`,
  `chat:<id>`, `learnings`, `notes:<id>`.
- Every `set`/`delete` fires a `VaultChange` with `{ ns, key }` onto the
  `host.onChange()` feed.
- On the web side, stores hydrate from the vault at boot and write through — no
  direct localStorage. The change feed keeps all views live without polling.
- `apps/host/src/serve.ts` wires reactors off the change feed: launch-on-create
  (spawn agent when session has `pendingLaunch`), reap-on-complete (kill agents
  when card hits Done).
- By default, all orden-generated structure lives in the vault, not inside
  project folders. A project's project page is a vault page keyed by `notes:<id>`.
- `DiskVault` (`apps/host/src/diskVault.ts`) stores one JSON file per `(ns, key)`
  under the vault root directory, so the data is legible on disk.
- `EmittingVault` wraps any `VaultStore` and fires changes on each write.

**Rejected alternatives:**

- **Scattering orden state into project folders.** Makes multi-project state
  management complex and couples tooling to project layout.
- **A database (SQLite, Postgres).** Unnecessary for a single-user tool;
  file-per-key JSON is simple, debug-friendly, and trivially backed up.
- **Direct localStorage in the web app.** Cannot survive a browser clear, cannot
  share state between browser tabs, and cannot be observed by the host for
  reactors. localStorage is only used by `BrowserHost` (the try-it/offline demo).

## Consequences

**Easier:**

- All app state is observable — any write is visible to every consumer via the
  change feed.
- Host-side reactors (launch, reap, hooks) work by watching the same vault the web
  writes to.
- The vault directory is a human-readable, backup-friendly tree of JSON files.
- Adding a new kind of state is one new namespace — no schema migration.

**Harder:**

- No transactional writes across keys. Two writes to different keys can't be
  atomic, so consumers must tolerate seeing partial state.
- Every consumer must hydrate at boot and stay subscribed to changes — the pattern
  is consistent but must be followed everywhere.
- File-per-key storage means listing a namespace with many entries requires a
  filesystem scan (acceptable for single-user scale).
