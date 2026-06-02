# Unified Chat UI Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** A native HTML Chat tab for orden that streams agent turns, renders markdown + tool-call cards, prompts for tool permissions, and supports slash commands, model selection, multi-turn, and resume — across the Claude and opencode harnesses, with new harnesses addable by dropping in one adapter.

**Architecture:** Modular. A new pure-TS package `@orden/chat-core` holds the harness-agnostic engine: types, the normalized `DriverEvent` stream, the `HarnessAdapter`/`HarnessDriver` interfaces, an adapter registry, the `reduceToVault` reducer, and a single generic `ChatBackend` engine. Harness adapters live in `apps/host/src/chat/adapters/*` (each self-contained, carrying its own SDK) and register into the engine. A new framework-free package `@orden/chat-ui` holds the frontend (store + view), depending only on chat-core + a `ChatClient` interface. `apps/web` is thin glue. Backends write a normalized parts model into the vault (ns `chat:<sessionId>`); orden's existing `onChange`/ws feed streams it to the UI.

**Tech Stack:** TypeScript, pnpm workspace, Vitest. chat-core: pure TS. Adapters: `@anthropic-ai/claude-agent-sdk`, `@opencode-ai/sdk`. chat-ui: vanilla DOM. Glue: the existing `@orden/host-client` ws bridge.

**Worktree:** `/home/b/projects/orden/.claude/worktrees/chat-ui` (branch `chat-ui`). Baseline: 336 tests passing.

**Design doc:** `docs/plans/2026-06-02-unified-chat-ui-design.md`.

---

## Conventions

- TDD throughout: failing test → run-it-fails → minimal impl → run-it-passes → commit.
- Per-package tests: `pnpm --filter <pkg> test`. New packages mirror an existing one's `package.json`/`tsconfig.json`/vitest setup (copy `packages/host-api` as the template — it is the smallest pure-TS package).
- Commit after every green step. No Claude attribution in messages. Never `git add .` — stage explicit paths.
- Vault shape for chat: ns = `chat:<sessionId>`; keys = `meta` (`ChatSession`), `msg:<seq>` (each `ChatMessage`, zero-padded), `perm:<permId>` (open `PermissionRequest`, deleted on response). Each part update is one small keyed write the feed delivers incrementally.
- The engine writes through a minimal `ChatVault` port (`get/set/list/delete` by `(ns,key)`) — structurally `VaultStore`, but declared in chat-core so the package has no `@orden/host-api` dependency. The host passes its real (emitting) vault in.

---

## Phase 0 — Scaffold `@orden/chat-core` + types

### Task 1: Create the package

**Files:** Create `packages/chat-core/{package.json,tsconfig.json,src/index.ts}`; add to `pnpm-workspace.yaml` if packages aren't globbed (check first).

Copy `packages/host-api`'s `package.json`/`tsconfig.json`, rename to `@orden/chat-core`, empty `src/index.ts`. Run `pnpm install` so the workspace links it. Verify `pnpm --filter @orden/chat-core test` runs (0 tests ok). Commit.

### Task 2: Core types

**Files:** Modify `packages/chat-core/src/index.ts`; test `packages/chat-core/test/types.test.ts`.

TDD a type-composition guard (as before) then add: `ChatHarness`, `ChatSession`, `ChatPart`, `ChatMessage`, `PermissionRequest`, `ModelOption`, `SlashCommand`, `PermissionDecision`, `ChatBackend` (the public surface, signatures from the design doc), plus the modular contracts: `DriverEvent`, `HarnessDriver`, `HarnessAdapter`, and `ChatVault`. (Exact field shapes in the design doc's "Engine and adapters" and "Normalized model" sections.) Commit.

### Task 3: host-api re-exports chat types

**Files:** Modify `packages/host-api/src/index.ts` (add `export * from "@orden/chat-core"` for the chat types, or a targeted re-export; add `chat?: ChatBackend` to `Host`); add `@orden/chat-core` to `packages/host-api` deps. Extend `packages/host-api/test` to assert `Host.chat` is typed. Commit.

---

## Phase 1 — The engine (pure, TDD against fakes)

### Task 4: `reduceToVault`

**Files:** Create `packages/chat-core/src/reduceToVault.ts`; test `packages/chat-core/test/reduceToVault.test.ts`.

A pure function/class that applies one `DriverEvent` to a `ChatVault` for a session. One behaviour per TDD cycle, each its own commit:

1. `session` event upserts `chat:<id>/meta` (sets resolved sessionId, slashCommands).
2. `text` appends/updates the text part of the current assistant `msg:<seq>`.
3. `tool` adds a `{type:'tool',state:'running'}` part; `tool-result` flips it to `done`/`error` with output.
4. `turn-end` finalizes the message; any still-`running` tool flips to `error` defensively.
5. Out-of-order arrival: a `tool-result` before its `tool` is buffered/no-crash.

Use an in-memory `ChatVault` fake (a `Map`). No driver, no SDK.

### Task 5: The `ChatBackend` engine over a registry

**Files:** Create `packages/chat-core/src/engine.ts` and `packages/chat-core/src/registry.ts`; test `packages/chat-core/test/engine.test.ts`.

`registry.ts`: `registerAdapter(adapter)` / `getAdapter(harness)` (a simple map; also support an injected registry instance for tests — avoid global-only state).

`engine.ts`: `createChatBackend({ vault, registry })` returns a `ChatBackend`. Behaviours, each TDD'd against a **fake adapter** whose `open()` returns a **fake driver** (scriptable `events`, recording `send`/`setModel`, a `firePermission()` helper):

1. `createSession` writes `meta`, opens the adapter's driver, and starts piping `driver.events` through `reduceToVault`.
2. A scripted turn produces the expected `getMessages` output (delegates to the reducer — assert end-to-end).
3. Permission: `driver.onPermission` firing writes `perm:<id>` and parks a resolver; `respondPermission(sessionId,id,{decision:'allow'})` resolves it (observe the fake driver's permission promise settle) and deletes `perm:<id>`.
4. `send`/`setModel` delegate to the driver; `listCommands` to `driver.listCommands`; `listModels(harness)` to `adapter.listModels`.
5. Resume: a fresh engine over the same vault → `getMessages` replays history; re-opening drives new events onto the existing message log.

This is the whole harness-agnostic system, proven without any real harness. Commit per behaviour.

---

## Phase 2 — The adapter contract (the gate)

### Task 6: `runAdapterContract` shared suite

**Files:** Create `packages/chat-core/src/testing/adapterContract.ts` (exported test helper) and `packages/chat-core/test/adapterContract.selftest.test.ts`.

`runAdapterContract(makeAdapter, scenario)` is a reusable suite asserting any `HarnessAdapter` satisfies the contract when driven by a scripted scenario: open → scripted turn (text + tool + tool-result + turn-end) yields the canonical normalized parts; a fired permission round-trips; `listModels` returns ≥1 option; `setModel`/`send` are accepted; `close` is clean. The self-test runs it against the in-repo fake adapter to prove the suite itself is correct.

Every real adapter (Tasks 8, 10) imports and runs this. A future harness is "done" only when it passes this suite. Commit.

---

## Phase 3 — Adapters

### Task 7: SDK dependencies

**Files:** Modify `apps/host/package.json`.

```bash
pnpm --filter @orden/host add @anthropic-ai/claude-agent-sdk @opencode-ai/sdk @orden/chat-core
```

**COOLDOWN WARNING:** repo sets `minimumReleaseAge=43200` (30 days). If a package's latest is younger, pin a >30-day-old version explicitly rather than disabling the cooldown. Record resolved versions in the commit message. Commit.

### Task 8: Claude adapter

**Files:** Create `apps/host/src/chat/adapters/claude.ts`; test `apps/host/test/chat/claude.adapter.test.ts`.

Implement `HarnessAdapter` (`harness:"claude"`). `open()` wraps `@anthropic-ai/claude-agent-sdk` `query()` in streaming-input mode (`permissionMode:"default"`, `settingSources:[]`), translating SDK messages → `DriverEvent`s and `canUseTool` → `onPermission`. `listModels` returns the curated catalog (opus/sonnet/haiku + `[1m]` variant; ids = model strings).

Two test layers: (a) a **pure mapper** `sdkMessageToEvents()` factored out and unit-tested against recorded SDK-message fixtures — no live process; (b) `runAdapterContract` against a version of the adapter whose `query` is dependency-injected with a fake. Plus one env-gated live smoke (`ORDEN_LIVE_CLAUDE=1`). Commit.

### Task 9: opencode adapter

**Files:** Create `apps/host/src/chat/adapters/opencode.ts`; test `apps/host/test/chat/opencode.adapter.test.ts`.

Implement `HarnessAdapter` (`harness:"opencode"`). `open()` ensures a project-scoped `opencode serve` child (reuse any existing serve helper in `apps/host` — check `nodeSessions.ts`/connectors first, DRY), subscribes `event.subscribe()` SSE → `DriverEvent`s (pure mapper `sseEventToEvents()` unit-tested against fixtures), uses `session.create/prompt/command`, `config.providers()` → `listModels`, and the permission bus event → `onPermission` answered via `postSessionByIdPermissionsByPermissionId`. Run `runAdapterContract` + env-gated smoke (`ORDEN_LIVE_OPENCODE=1`). Commit.

---

## Phase 4 — Host wiring

### Task 10: NodeHost.chat + registry + RPC + BrowserHost stub

**Files:** Modify `apps/host/src/nodeHost.ts` (build the engine: register both adapters, pass the emitting vault), `apps/host/src/wsServer.ts` (proxy `chat.*` RPC), `apps/web/src/host/browserHost.ts` (`chat` stub: `listSessions`→[], others throw "no host"). Tests: extend `apps/host/test/host.test.ts` (RPC round-trip: `createSession` over the bridge; assert a `chat:*` change fires on `onChange` because the engine uses the emitting vault) and `apps/web/test/browserHost.test.ts`. Commit.

---

## Phase 5 — `@orden/chat-ui` package

### Task 11: Scaffold the package

**Files:** Create `packages/chat-ui/{package.json,tsconfig.json,src/index.ts}` (copy a DOM-testing package's vitest/happy-dom setup — mirror `apps/web`'s config). Depend on `@orden/chat-core`. Define the `ChatClient` interface in `src/client.ts` (the methods the UI calls — same signatures as `ChatBackend`, transport-agnostic). `pnpm install`, verify tests run. Commit.

### Task 12: `chatStore` (pure reducer)

**Files:** Create `packages/chat-ui/src/chatStore.ts`; test `packages/chat-ui/test/chatStore.test.ts`.

`hydrate(messages)`, `applyChange(ns,key,value)` (msg:* upsert by seq, perm:* add, perm: delete), selectors `messages()`/`pendingPermissions()`, `onChange(cb)`. Pure, fully unit-tested: out-of-order parts, tool state transitions, permission appear/clear. Commit per behaviour.

### Task 13: `chatView` (DOM)

**Files:** Create `packages/chat-ui/src/chatView.ts`; test `packages/chat-ui/test/chatView.test.ts` (light DOM smoke over a scripted store snapshot).

Render messages → parts: text via a markdown renderer (inject it as a dep so chat-ui carries no markdown lib of its own — `apps/web` passes the one it already uses), tool parts as collapsible cards, permission requests as inline allow/deny calling `client.respondPermission`. `/`-triggered command palette from `client.listCommands`; model `<select>` from `client.listModels` bound to `createSession`/`setModel`; composer calling `client.send`. Real verification is running the app. Commit.

---

## Phase 6 — Mount in `apps/web`

### Task 14: ChatClient impl + Chat tab + feed wiring

**Files:** Modify `apps/web/src/main.ts` and `sessionsPanel.ts` to offer a Chat tab beside Terminal; create `apps/web/src/chatClient.ts` (adapts `host.chat` RPC to chat-ui's `ChatClient`); mount `@orden/chat-ui`, inject the existing markdown renderer; subscribe `onVaultChange((ns,key)=>{ if (ns.startsWith("chat:")) store.applyChange(...) })`; hydrate via `getMessages` on open. Reuse the existing tab/panel affordance. Commit.

---

## Phase 7 — Verify in the real app

### Task 15: Build + run + observe

- `pnpm --filter @orden/web build` (served from dist, no HMR).
- Launch the host via `tsx` directly (not `pnpm start`).
- Start a Claude chat: send a turn, watch parts stream, trigger a permission, approve, switch model, run a slash command, reload to confirm resume. Repeat for opencode.
- `xdg-open` the running app for the user (show-don't-narrate). Fix gaps, re-run `pnpm -r test`, confirm 336+ green plus the new suites.

---

## Done criteria

- `@orden/chat-core` (engine + registry + reducer) and `@orden/chat-ui` (store + view) are standalone packages with no host/node/DOM cross-coupling.
- One `runAdapterContract` suite both adapters pass; adding a harness = a new `adapters/<name>.ts` that passes it + one register line, with zero changes to core, UI, or other adapters.
- Chat tab streams turns, renders tool cards + markdown, approves/denies permissions, runs slash commands, switches models, resumes after reload — for both harnesses.
- Terminal tab untouched. No one-shot `claude -p`. Full suite green.
