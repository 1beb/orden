# ADR-0004: Host interface as the spine, Browser/Node implementations

**Date:** 2026-05-29
**Status:** accepted

## Context

The web UI needs access to the filesystem, agent sessions, and persistent storage.
These capabilities cannot run in the browser. The same UI should work as a pure web
app (limited), against a local Node service (full), and eventually as a desktop app
— without code forks.

## Decision

**Define a single `Host` interface (`packages/host-api`). The web app depends
only on `Host`. Multiple implementations satisfy it.**

- `Host` bundles: `identity`, `vault` (VaultStore), `projects` (ProjectRegistry),
  `files` (FileSource), `sessions` (SessionManager), `locks` (LockService),
  optional `chat` (ChatBackend), optional `terminalChat` (TerminalChat), and
  `capabilities()` (HostCapabilities — which features this host supports).
- Two implementations:
  - **BrowserHost** (`apps/web/src/host/browserHost.ts`): in-browser, vault backed
    by browser storage, no remote projects or real agents (capabilities false,
    methods no-op).
  - **NodeHost** (`apps/host/src/nodeHost.ts`): full backend — DiskVault on disk,
    real filesystem files (FsFiles), real claude/opencode agent processes
    (tmux + node-pty), optional chat backend.
- **HostClient**: an implementation of `Host` that proxies calls over WebSocket
  JSON-RPC to a remote NodeHost. A single host-URL flag
  (`apps/web/src/host/selectHost.ts`) picks BrowserHost vs HostClient.
- The WebSocket transport (`apps/host/src/rpc.ts` + `wsTransport.ts`) is
  deliberately split: the browser-safe re-exports in `apps/host/src/client.ts`
  exclude Node-only modules so the browser bundle never pulls in `ws`/`node:fs`.
- Future `DesktopHost` wraps NodeHost in a Tauri/Electron shell with native
  pickers, using the same `Host` interface.

**Rejected alternatives:**

- **Multiple frontend builds per deployment target.** Would fork the UI code.
  The `Host` abstraction means one web build targets all deployments.
- **Direct Node imports in the web app.** Would break the browser-only build and
  tie the UI to a specific transport.

## Consequences

**Easier:**

- The web UI never imports `fs`, `ssh`, `node:pty`, or any Node-specific module —
  only `Host` methods. This keeps the browser build clean.
- A deployment flag swaps the host without touching any feature code.
- The interface boundary is the natural seam for testing: swap in a fake `Host`
  and test UI behavior without real files or agents.
- SaaS/commercial deployment slots in as a new `Host` implementation without
  changing the client.

**Harder:**

- Every new host capability requires adding a method to `Host`, implementing it
  in NodeHost (with real behavior), stubbing it in BrowserHost, and proxying it
  in the WebSocket RPC. This is three touchpoints per feature, but each is
  mechanical.
- The `capabilities()` flag system means the UI must always check capabilities
  before calling methods — missing a check produces a runtime no-op rather than
  a compile error.
