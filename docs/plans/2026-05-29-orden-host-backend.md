# Orden Host Backend Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (or subagent-driven-development) to implement task-by-task.

**Goal:** Give orden a real backend — a vault for its own data, projects from local *and* remote sources, and AI sessions it can spawn and resume — behind one **Host** abstraction so the *same* web UI runs as a web app (remote host), a local Node service, or a desktop app.

**Architecture:** The frontend depends only on a `Host` interface (capabilities: `vault`, `projects`, `files`, `sessions`). Multiple implementations satisfy it: `BrowserHost` (localStorage/IndexedDB — limited, no remote/spawn), `NodeHost` (a local service over WebSocket JSON-RPC — full: fs, ssh/sftp, tmux, `claude --resume`), and later `DesktopHost` (Tauri/Electron wrapping NodeHost in-process + native pickers). All current localStorage usage (persist, pages, settings, feedback sink) moves behind `host.vault`; file loading behind `host.files`; the Kanban behind `host.sessions`. This keeps location and runtime orthogonal to the UI and leaves room for a hosted/commercial deployment.

**Tech Stack:** TypeScript across the board. Host interface as a shared package. NodeHost: Node + `ws` (or MCP), `ssh2`/`ssh2-sftp-client`, `node-pty` + tmux, child_process for `claude`/`opencode`. Frontend unchanged stack (Vite/ProseMirror). Vitest for logic.

**Current state:** Frontend-only app with four standalone-ish concerns talking directly to localStorage — `persist.ts` (annotations+doc), `pages.ts` (journal/pages), `settings.ts`, `sink-local.ts` (feedback outbox) — plus `files.ts` reading repo docs via `import.meta.glob`, and a mock Kanban. These become the first `BrowserHost`.

---

## The Host interface (the spine)

Define once; everything else implements or consumes it.

```ts
// packages/host-api/src/index.ts
export interface Host {
  vault: VaultStore;
  projects: ProjectRegistry;
  files: FileSource;
  sessions: SessionManager;
  capabilities(): HostCapabilities; // which features this host supports
}

export interface HostCapabilities {
  remoteProjects: boolean;
  spawnSessions: boolean;
  persistentVault: boolean;
}

// Namespaced key/value the app's data lives in (journal, annotations, kanban, settings).
export interface VaultStore {
  get<T>(ns: string, key: string): Promise<T | null>;
  set<T>(ns: string, key: string, value: T): Promise<void>;
  list(ns: string): Promise<string[]>;
  delete(ns: string, key: string): Promise<void>;
}

export type ProjectSource =
  | { kind: "local"; path: string }
  | { kind: "ssh"; host: string; path: string; user?: string }
  | { kind: "s3"; bucket: string; prefix?: string }; // future

export interface Project { id: string; name: string; source: ProjectSource; }

export interface ProjectRegistry {
  list(): Promise<Project[]>;
  add(source: ProjectSource, name?: string): Promise<Project>;
  remove(id: string): Promise<void>;
}

export interface FileEntry { path: string; title: string; }
export interface FileSource {
  list(projectId: string, glob?: string): Promise<FileEntry[]>;
  read(projectId: string, path: string): Promise<string>;
  write(projectId: string, path: string, content: string): Promise<void>;
}

export type SessionState =
  | "backlog" | "todo" | "in-progress" | "blocked" | "ready" | "complete" | "broken";

export interface Session {
  id: string;
  projectId: string;
  title: string;
  state: SessionState;
  conversationId?: string; // e.g. Claude Code session id for `claude --resume`
  cwd: string;             // recorded working directory
  agent: "claude" | "opencode";
}

export interface SessionManager {
  list(): Promise<Session[]>;
  spawn(projectId: string, opts: { title: string; agent: "claude" | "opencode" }): Promise<Session>;
  // Attach to a live or stale session; resumes via `cd <cwd> && <agent> --resume <conversationId>`
  // when detached. Returns a transport handle (pty stream id / ws channel).
  open(sessionId: string): Promise<{ channel: string }>;
  transition(sessionId: string, to: SessionState): Promise<void>;
}
```

---

## Phase H0 — Host interface + BrowserHost (no behavior change)

### Task H0.1: `packages/host-api`
Create the standalone package with the interfaces above (types only, zero deps). Tests: type-level + a no-op conformance fixture.

### Task H0.2: `BrowserHost` in apps/web
Implement `Host` over the browser: `vault` = localStorage (namespaced `orden:<ns>:<key>`), `files` = the current `import.meta.glob` repo source as a single implicit "this-repo" project, `sessions` = the current mock cards (read-only; `spawn`/`open` throw "unsupported"), `capabilities()` = `{ remoteProjects:false, spawnSessions:false, persistentVault:true }`. TDD the vault.

### Task H0.3: Route the app through Host
Refactor `persist.ts`, `pages.ts`, `settings.ts`, `sink-local.ts`, `files.ts`, and the Kanban to call `host.*` instead of localStorage/glob directly. **Acceptance:** app behaves exactly as today, but now depends only on the `Host` interface (verified by swapping in a stub host in a test). Commit.

---

## Phase H1 — NodeHost service + HostClient (full capabilities, local)

### Task H1.1: `apps/host` Node service
A Node process exposing `Host` over WebSocket JSON-RPC (method = `vault.get`, etc.). Vault persisted to a chosen directory on disk (JSON files per ns/key). `capabilities` = all true.

### Task H1.2: `HostClient` in the web app
An implementation of `Host` that proxies each call over the WebSocket to `apps/host`. A build/env flag selects `BrowserHost` vs `HostClient`. **Acceptance:** run `apps/host` + the web UI against it; journal/annotations/kanban persist to disk (survive a hard refresh AND a server restart); same UI, real vault.

---

## Phase H2 — Vault selection + projects (local)

### Task H2.1: Vault location
First-run flow to choose the vault directory (NodeHost: a path; BrowserHost: implicit). Persist the choice. Settings shows/allows changing it.

### Task H2.2: Project registry + local FileSource + "Add project"
NodeHost implements `projects.add({kind:"local",path})` and `files.list/read/write` over fs. UI: an "Add project" action in the left nav (folder path input; native picker under DesktopHost later). Replace the repo-doc `import.meta.glob` with `host.files.list(projectId)`. **Acceptance:** add a local folder as a project; its markdown files appear in the nav and open in the review editor; edits write back via `host.files.write`.

---

## Phase H3 — Sessions: spawn + resume

### Task H3.1: Session manager (spawn)
NodeHost `sessions.spawn` launches the agent (`claude`/`opencode`) inside the project's working dir via tmux + `node-pty`; records `{id, conversationId, cwd, projectId, state, agent}` in the vault. Discover/capture the agent's conversation id (Claude Code writes a session id; capture it from its session store/JSONL path).

### Task H3.2: Kanban → sessions
Kanban cards come from `host.sessions.list()` (real, replacing mocks). A "spawn" affordance creates a session (→ a card). Lifecycle columns reflect `state`; `transition` moves them.

### Task H3.3: Open / resume + terminal
Clicking a card calls `sessions.open(id)`: if live, attach; if stale, resume via `cd <cwd> && <agent> --resume <conversationId>`. The right pane renders the pty stream over the ws channel (xterm.js). **Acceptance:** spawn a Claude session in a project; it appears as a card; close/detach; click the card later → it resumes the same conversation in the recorded directory, shown live in the right pane.

---

## Phase H4 — Remote sources

### Task H4.1: ssh/sftp project source
`projects.add({kind:"ssh",...})`; `FileSource` over `ssh2-sftp-client`; sessions spawn over `ssh host tmux …` (the design doc's local-or-remote-is-identical surface). **Acceptance:** add a remote folder over ssh; browse/open/edit its files; spawn + resume a session on the remote host.

### Task H4.2: Remote vault + S3 (later)
Allow the vault itself to live remotely (ssh/sftp). S3 source/vault adapter behind the same interfaces. Deferred until local + ssh are solid.

---

## Phase H5 — Desktop + hosted

### Task H5.1: DesktopHost (Tauri)
Wrap the web client + NodeHost in a Tauri shell; native folder picker for vault/project selection; NodeHost runs as a sidecar or in-process. All-JS Electron is the fallback if Rust toolchain is a barrier.

### Task H5.2: Hosted web
Deploy the web client against a remote NodeHost (per-user). Auth + multi-tenant + credential security are a **separate plan** (commercial concern) — out of scope here.

---

## Cross-cutting

- **Security:** remote creds (ssh keys, S3, tokens) never touch the browser bundle; they live in the host. Document the trust boundary before H4.
- **MCP:** the design doc names MCP as the structured bus. The WebSocket JSON-RPC here can be MCP-framed; decide at H1 whether to adopt MCP transport directly or wrap later.
- **Migration:** BrowserHost vault → NodeHost vault import path so early localStorage data isn't lost.

## Done criteria

- One `Host` interface; the web UI depends only on it.
- `BrowserHost` (today's behavior) and `NodeHost` (disk vault, local projects, spawn/resume) both satisfy it; a flag swaps them with no UI change.
- Add a project from a local folder (and, by H4, a remote one); pick a vault; open/edit files through the host.
- Kanban cards are real sessions; clicking spawns/opens, and a stale session resumes by conversation id in its recorded cwd.
- Desktop shell and hosted web are reachable from the same client.
