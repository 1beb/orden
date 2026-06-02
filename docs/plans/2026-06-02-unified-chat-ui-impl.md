# Unified Chat UI Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a native HTML Chat tab to orden that streams agent turns, renders markdown + tool-call cards, prompts for tool permissions, and supports slash commands, model selection, multi-turn, and resume — across both the Claude and opencode harnesses.

**Architecture:** One `ChatBackend` interface, two host-side implementations (claude via `@anthropic-ai/claude-agent-sdk`, opencode via its serve API + `@opencode-ai/sdk`). Each backend is split behind a thin `HarnessDriver` seam so the normalization logic is unit-tested against scripted fakes with no live process. Backends write a normalized parts model into the vault (ns `chat:<sessionId>`); orden's existing `onChange`/ws change feed streams it to the web, where a `chatStore` reduces feed deltas and `chatView` renders. Permission requests normalize a pull (Claude `canUseTool`) and a push (opencode POST) behind one `respondPermission`.

**Tech Stack:** TypeScript, pnpm workspace, Vitest. Host: Node, `@anthropic-ai/claude-agent-sdk`, `@opencode-ai/sdk`. Web: vanilla TS DOM (no framework), the existing `@orden/host-client` ws bridge.

**Worktree:** `/home/b/projects/orden/.claude/worktrees/chat-ui` (branch `chat-ui`). Baseline: 336 tests passing.

**Design doc:** `docs/plans/2026-06-02-unified-chat-ui-design.md`.

---

## Conventions

- TDD throughout: failing test → run-it-fails → minimal impl → run-it-passes → commit.
- Run a single package's tests with `pnpm --filter <pkg> test` (e.g. `pnpm --filter @orden/host-api test`). Run one file with `pnpm --filter <pkg> test <path>`.
- Commit after every green step. No Claude attribution in messages (repo rule). Never `git add .` — stage explicit paths.
- Vault key shape for chat: ns = `chat:<sessionId>`, keys = `meta` (the `ChatSession`), `msg:<seq>` (each `ChatMessage`, zero-padded seq), `perm:<permId>` (open `PermissionRequest`; deleted on response). This keeps each part-update a small keyed write the feed can deliver incrementally.

---

## Phase 0 — Types and dependencies

### Task 1: ChatBackend types in host-api

**Files:**
- Modify: `packages/host-api/src/index.ts` (append types; add `chat` to `Host`)
- Test: `packages/host-api/test/chat.types.test.ts` (create)

**Step 1: Write the failing test** — a compile-level guard that the types exist and a `ChatMessage` composes parts.

```ts
import { describe, it, expect } from "vitest";
import type { ChatMessage, ChatPart, ChatBackend } from "../src/index";

describe("chat types", () => {
  it("composes a message from text and tool parts", () => {
    const parts: ChatPart[] = [
      { type: "text", text: "hi" },
      { type: "tool", toolId: "t1", name: "Write", input: {}, state: "done", output: "ok" },
    ];
    const msg: ChatMessage = { id: "m1", role: "assistant", parts };
    expect(msg.parts).toHaveLength(2);
    // type-only reference so ChatBackend must be exported
    const _b: ChatBackend | null = null;
    expect(_b).toBeNull();
  });
});
```

**Step 2: Run** `pnpm --filter @orden/host-api test` → FAIL (no exported `ChatPart`/`ChatBackend`).

**Step 3: Implement** — append to `packages/host-api/src/index.ts`:

```ts
export type ChatHarness = "claude" | "opencode";

export interface ChatSession {
  id: string;
  title: string;
  harness: ChatHarness;
  cwd: string;
  model?: string;
  createdAt: number;
}

export type ChatPart =
  | { type: "text"; text: string }
  | {
      type: "tool";
      toolId: string;
      name: string;
      input: unknown;
      state: "pending" | "running" | "done" | "error";
      output?: string;
    };

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  parts: ChatPart[];
}

export interface PermissionRequest {
  id: string;
  toolName: string;
  input: unknown;
  title: string;
}

export interface ModelOption {
  harness: ChatHarness;
  id: string; // opaque to the UI; backend translates to native form
  label: string;
}

export interface SlashCommand {
  name: string;
  description?: string;
}

export interface PermissionDecision {
  decision: "allow" | "deny";
  remember?: boolean;
}

export interface ChatBackend {
  listSessions(): Promise<ChatSession[]>;
  createSession(opts: {
    harness: ChatHarness;
    cwd: string;
    title?: string;
    model?: string;
  }): Promise<ChatSession>;
  getMessages(sessionId: string): Promise<ChatMessage[]>;
  send(sessionId: string, text: string, opts?: { model?: string }): Promise<void>;
  respondPermission(sessionId: string, reqId: string, d: PermissionDecision): Promise<void>;
  setModel(sessionId: string, model: string): Promise<void>;
  listModels(harness: ChatHarness): Promise<ModelOption[]>;
  listCommands(sessionId: string): Promise<SlashCommand[]>;
}
```

Add `chat?: ChatBackend;` to the `Host` interface (optional so BrowserHost can omit it initially; wired in Phase 4).

**Step 4: Run** `pnpm --filter @orden/host-api test` → PASS.

**Step 5: Commit** `git add packages/host-api/src/index.ts packages/host-api/test/chat.types.test.ts && git commit -m "feat(host-api): ChatBackend types"`

---

### Task 2: Add SDK dependencies

**Files:** Modify `apps/host/package.json`.

**Step 1:** Add to `apps/host` deps: `@anthropic-ai/claude-agent-sdk` and `@opencode-ai/sdk`.

```bash
pnpm --filter @orden/host add @anthropic-ai/claude-agent-sdk @opencode-ai/sdk
```

**COOLDOWN WARNING:** this repo sets `minimumReleaseAge=43200` (30 days). If either package's latest version is younger, pnpm will refuse or pin an older version. If it refuses: pin a >30-day-old version explicitly (`pnpm add pkg@<version>`), or temporarily note the exception. Do NOT disable the cooldown globally. Record the resolved versions in the commit message.

**Step 2: Run** `pnpm --filter @orden/host test` → still PASS (no usage yet).

**Step 3: Commit** `git add apps/host/package.json pnpm-lock.yaml && git commit -m "chore(host): add agent-sdk + opencode-sdk deps"`

---

## Phase 1 — Claude backend (behind a driver seam)

The backend logic that normalizes harness events into vault writes is the part worth testing. Isolate the live SDK behind `ClaudeDriver` so tests inject a scripted fake.

### Task 3: ClaudeDriver seam + fake

**Files:**
- Create: `apps/host/src/chat/claudeDriver.ts`
- Test: `apps/host/test/chat/claudeDriver.fake.test.ts`

Define the seam the backend consumes (NOT the live SDK yet):

```ts
// A normalized, harness-agnostic-ish driver event the backend reduces.
export type DriverEvent =
  | { kind: "session"; sessionId: string; slashCommands: string[] }
  | { kind: "text"; messageId: string; text: string }            // append/replace text part
  | { kind: "tool"; messageId: string; toolId: string; name: string; input: unknown }
  | { kind: "tool-result"; toolId: string; output: string; ok: boolean }
  | { kind: "turn-end" };

export interface ClaudeDriver {
  start(opts: { cwd: string; model?: string }): AsyncIterable<DriverEvent>;
  send(text: string): Promise<void>;
  setModel(model: string): Promise<void>;
  supportedCommands(): Promise<string[]>;
  // Permission pull: the driver invokes this when the SDK asks; resolve to decide.
  onPermission(cb: (req: { toolName: string; input: unknown; title: string }) =>
    Promise<{ allow: boolean }>): void;
}
```

Write a `makeFakeClaudeDriver(script: DriverEvent[])` test helper in the test file that yields scripted events and exposes a way to fire a permission request. Test asserts the fake yields the script and that `onPermission` fires. (This proves the seam shape before the backend depends on it.)

TDD: test first (fake yields scripted events incl. a tool + turn-end), run-fail, implement the interface + fake, run-pass, commit.

### Task 4: ClaudeChatBackend normalization → vault

**Files:**
- Create: `apps/host/src/chat/claudeChatBackend.ts`
- Test: `apps/host/test/chat/claudeChatBackend.test.ts`

The backend takes `{ vault: VaultStore, makeDriver: () => ClaudeDriver }`. Behaviour to test, each its own TDD cycle:

1. `createSession` writes `chat:<id>` / `meta` and returns the `ChatSession`.
2. Consuming a driver `text` event appends a text part to the current assistant `msg:<seq>` (vault write observed).
3. A `tool` event adds a `{type:"tool",state:"running"}` part; a `tool-result` flips it to `done`/`error` with output.
4. `turn-end` finalizes the assistant message (no dangling running tools — any still-running flips to `error` defensively).
5. A driver permission pull writes `chat:<id>`/`perm:<permId>` and parks the resolver; `respondPermission(id, permId, {decision})` resolves the parked promise and deletes the `perm:` key.
6. `getMessages` reads back `msg:*` in seq order.
7. `send` forwards to `driver.send`; `setModel` to `driver.setModel`; `listCommands` maps `supportedCommands()` strings to `SlashCommand[]`.

Use an in-memory `VaultStore` fake (a `Map`) and the `makeFakeClaudeDriver` from Task 3. No live SDK. Commit after each behaviour goes green (or batch 2-3 closely-related asserts per commit, your call — keep commits small).

### Task 5: Live ClaudeDriver impl (SDK)

**Files:** Modify `apps/host/src/chat/claudeDriver.ts` (add `makeClaudeDriver`).

Wrap `@anthropic-ai/claude-agent-sdk` `query()`:
- streaming-input mode: `prompt` is an `AsyncIterable<SDKUserMessage>` you push to from `send()`.
- `options.model` / `options.fallbackModel` from `start`; `options.permissionMode:"default"`, `options.settingSources:[]` (spike-proven isolation).
- `options.canUseTool = (name,input,opts) => onPermission(...)` mapped to `{behavior:"allow"|"deny"}`.
- map `system/init` → `session` event (+ `slash_commands`); `assistant` text blocks → `text`; `tool_use` blocks → `tool`; tool results → `tool-result`; `result` → `turn-end`.
- `setModel` → `q.setModel`; `supportedCommands` → `q.supportedCommands()` names.

This task is integration-shaped; cover it with ONE smoke test gated behind an env flag (`ORDEN_LIVE_CLAUDE=1`) that runs a real one-turn `/help`-style exchange, skipped in CI. The normalization is already covered by Task 4 against the fake. Commit.

### Task 6: Claude model catalog

`listModels("claude")` returns a static curated `ModelOption[]` (opus/sonnet/haiku + the `[1m]` variant), ids = model strings. Unit-test the shape. Commit.

---

## Phase 2 — opencode backend (same seam shape)

### Task 7: OpencodeDriver seam + fake

**Files:** Create `apps/host/src/chat/opencodeDriver.ts`; test `apps/host/test/chat/opencodeDriver.fake.test.ts`.

Same `DriverEvent` output type as Claude (that is the whole point — one normalized stream). The opencode fake scripts SSE-shaped inputs (`message.updated`/`part.updated`) and asserts they map to the SAME `DriverEvent`s. Permission here is push: the fake exposes `firePermission(req)` and the driver surfaces it through `onPermission` too, so the backend code is identical. TDD as before.

### Task 8: OpencodeChatBackend

**Files:** Create `apps/host/src/chat/opencodeChatBackend.ts`; test `apps/host/test/chat/opencodeChatBackend.test.ts`.

Identical behavioural contract to Task 4, driven by the opencode fake. Because both backends reduce the same `DriverEvent` stream into the same vault shape, factor the shared reducer into `apps/host/src/chat/reduceToVault.ts` (DRY) and have both backends call it. Refactor: once Task 8's tests pass against a copy, extract the shared reducer and re-run both backends' tests green. Commit the extraction separately.

### Task 9: Live OpencodeDriver impl

Wrap `@opencode-ai/sdk`: ensure a project-scoped `opencode serve` child (reuse any existing opencode-serve helper in `apps/host` if present — check `nodeSessions.ts`/connectors first; DRY), `event.subscribe()` SSE → `DriverEvent`, `session.create/prompt/command`, permission via `postSessionByIdPermissionsByPermissionId`. `listModels("opencode")` from `config.providers()`. Env-gated smoke test (`ORDEN_LIVE_OPENCODE=1`). Commit.

---

## Phase 3 — Shared contract test

### Task 10: One contract both backends pass

**Files:** Create `apps/host/test/chat/chatBackend.contract.test.ts`.

A parametrized suite run once per backend (each constructed with its fake driver) asserting the identical normalized outcome:

1. createSession → `getMessages` empty, `meta` present.
2. drive a scripted turn (text + a tool + tool-result + turn-end) → `getMessages` yields one assistant message with the expected ordered parts.
3. fire a permission mid-turn → a `perm:` key appears; `respondPermission(allow)` clears it and the turn proceeds.
4. resume: construct a fresh backend over the SAME vault → `getMessages` replays history.
5. `setModel` + `send` are accepted (forwarded to the driver, observed on the fake).

This is the proof that "both backends up front" produced a real shared abstraction. Commit.

---

## Phase 4 — Host wiring

### Task 11: NodeHost.chat + RPC proxy + BrowserHost stub

**Files:**
- Modify `apps/host/src/nodeHost.ts` (instantiate `chat` with the emitting vault + both backends, dispatched by `harness`)
- Modify `apps/host/src/wsServer.ts` (proxy `chat.*` RPC methods)
- Modify `apps/web/src/host/browserHost.ts` (a `chat` stub: `listSessions`→[], others throw "no host")
- Tests: extend `apps/host/test/host.test.ts` and `apps/web/test/browserHost.test.ts`

A single `ChatBackend` facade on NodeHost routes by session harness to the claude/opencode impl. Verify an RPC round-trip (createSession over the ws bridge) in a host test. The change feed already emits `chat:*` writes because the backends use the emitting vault — confirm with an `onChange` assertion. Commit.

---

## Phase 5 — Web chatStore (pure reducer, TDD)

### Task 12: chatStore reduces feed deltas

**Files:** Create `apps/web/src/chatStore.ts`; test `apps/web/test/chatStore.test.ts`.

A framework-free store: `hydrate(messages)`, `applyChange(ns,key,value)` (for `msg:*` upsert by seq, `perm:*` add, `perm:` delete → resolve), selectors `messages()`, `pendingPermissions()`, and an `onChange(cb)` to trigger re-render. Pure, fully unit-tested (opencode-web's "atomic store mutations"). Cover: out-of-order part arrival, tool state transition, permission appear/clear. Commit per behaviour.

---

## Phase 6 — Chat tab UI (thin; manual-verify)

### Task 13: chatView render

**Files:** Create `apps/web/src/chatView.ts`; mirror `sessionsPanel.ts`/`terminalView.ts` structure (plain DOM, injected deps).

Render messages → parts: text via the existing markdown renderer used elsewhere (find it — likely in the outliner/annotation render path; DRY, do not add a new markdown lib), tool parts as collapsible cards, permission requests as inline allow/deny buttons calling `host.chat.respondPermission`. A `/`-triggered command palette from `listCommands`; a model `<select>` from `listModels` bound to `createSession`/`setModel`. A composer input calling `host.chat.send`. Light DOM smoke test (renders a scripted store snapshot); real verification is running the app.

### Task 14: Mount the Chat tab + feed wiring

**Files:** Modify `apps/web/src/main.ts` and the sessions panel to offer a Chat tab beside Terminal; subscribe `onVaultChange((ns,key)=>{ if(ns.startsWith("chat:")) store.applyChange(...) })`; on open, `getMessages` to hydrate. Reuse the existing tab/panel affordance in `sessionsPanel.ts`. Commit.

---

## Phase 7 — Verify in the real app

### Task 15: Build + run + observe

- `pnpm --filter @orden/web build` (web is served from dist — no HMR; see the run-orden-locally note).
- Launch the host via `tsx` directly (not `pnpm start`, which orphans the node child).
- Open the app, start a Claude chat session, send a turn, watch parts stream, trigger a tool that needs permission, approve it, switch model, run a slash command, reload to confirm resume. Repeat for opencode.
- Per the show-don't-narrate rule, `xdg-open` the running app for the user rather than describing screenshots.
- Fix any wiring gaps found, re-run the full suite (`pnpm -r test`), confirm 336+ tests still green plus the new ones.

---

## Done criteria

- One `ChatBackend` interface, two impls, ONE contract test both pass.
- Chat tab streams turns, renders tool cards + markdown, approves/denies permissions, runs slash commands, switches models, resumes after reload — for both harnesses.
- Terminal tab untouched. No one-shot `claude -p`. Full test suite green.
```
