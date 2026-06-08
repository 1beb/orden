# Session Mode Grid Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Each task: write the failing test, run it red, implement minimally, run it green, commit. Use @superpowers:test-driven-development for every task.

**Goal:** Let the user pick TUI or GUI per tool (Claude / opencode) in a settings grid; make the Claude GUI a live token-streaming SDK session; add a generic scratch terminal button.

**Architecture:** A session gains a fixed `mode: "tui" | "gui"`. TUI = today's tmux terminal; GUI = the existing chat-engine agent path (`chatMount.ts` already has it), upgraded so Claude streams via the SDK's `includePartialMessages`. The settings grid stamps `mode` onto new sessions; the sessions panel renders only the chosen surface. A scratch-terminal branch in the `/term` handler launches a plain shell.

**Tech Stack:** TypeScript, pnpm workspace, vitest, `@anthropic-ai/claude-agent-sdk@0.2.126`, node-pty + tmux, happy-dom for web tests.

**Design doc:** `docs/plans/2026-06-08-session-mode-grid-design.md` (read it first).

**Working dir:** This worktree, `.claude/worktrees/session-mode-grid`, branch `feature/session-mode-grid`. Run `pnpm -r typecheck` and the relevant package `test` after each phase.

---

## Phase A — Claude GUI streaming

### Task 1: Add a `thinking` DriverEvent kind

**Files:**
- Modify: `packages/chat-core/src/index.ts:111-116` (the `DriverEvent` union)
- Test: `packages/chat-core/test/reduceToVault.test.ts` (added in Task 2)

**Step 1: Extend the union.** In `packages/chat-core/src/index.ts`, add a `thinking` member mirroring `text`:

```ts
export type DriverEvent =
  | { kind: "session"; sessionId: string; slashCommands: string[] }
  | { kind: "text"; messageId: string; text: string }
  | { kind: "thinking"; messageId: string; text: string }
  | { kind: "tool"; messageId: string; toolId: string; name: string; input: unknown }
  | { kind: "tool-result"; toolId: string; output: string; ok: boolean }
  | { kind: "turn-end" };
```

**Step 2: Typecheck.** Run: `pnpm --filter @orden/chat-core typecheck`
Expected: PASS (the `ChatPart` union in this same file already has `{ type: "thinking"; text: string; tokens?: number }`, so the vault model is ready). The `reduceToVault` switch will now be non-exhaustive at runtime but still compiles; Task 2 handles it.

**Step 3: Commit.**
```bash
git add packages/chat-core/src/index.ts
git commit -m "chat-core: add thinking DriverEvent kind"
```

---

### Task 2: Reduce thinking deltas into a thinking part

**Files:**
- Modify: `packages/chat-core/src/reduceToVault.ts` (the `apply` switch + a new `onThinking`)
- Test: `packages/chat-core/test/reduceToVault.test.ts`

**Step 1: Write the failing test.** Append to `reduceToVault.test.ts` (match the existing test style — they construct a `VaultReducer` over a `MemVault` and assert the written `msg:<seq>`):

```ts
it("concatenates consecutive thinking deltas into one thinking part", async () => {
  const { vault, reducer, ns } = setup(); // reuse the file's existing helper
  await reducer.apply({ kind: "thinking", messageId: "m1", text: "Plan" });
  await reducer.apply({ kind: "thinking", messageId: "m1", text: "ning…" });
  const m = await vault.get<ChatMessage>(ns, "msg:0000");
  expect(m?.parts).toEqual([{ type: "thinking", text: "Planning…" }]);
});

it("keeps thinking and text as separate parts in order", async () => {
  const { vault, reducer, ns } = setup();
  await reducer.apply({ kind: "thinking", messageId: "m1", text: "hmm" });
  await reducer.apply({ kind: "text", messageId: "m1", text: "answer" });
  const m = await vault.get<ChatMessage>(ns, "msg:0000");
  expect(m?.parts).toEqual([
    { type: "thinking", text: "hmm" },
    { type: "text", text: "answer" },
  ]);
});
```

If the file has no shared `setup()` helper, mirror however the existing tests build a reducer (check the top of the file first).

**Step 2: Run red.** `pnpm --filter @orden/chat-core exec vitest run test/reduceToVault.test.ts -t "thinking"`
Expected: FAIL (thinking events currently fall through the switch and write nothing).

**Step 3: Implement.** In `reduceToVault.ts`, add a `case "thinking"` to the `apply` switch (next to `case "text"`) and an `onThinking` method mirroring `onText`:

```ts
case "thinking":
  await this.onThinking(ev);
  return;
```

```ts
private async onThinking(ev: { messageId: string; text: string }): Promise<void> {
  const msg = await this.openMessage(ev.messageId);
  const last = msg.parts[msg.parts.length - 1];
  if (last && last.type === "thinking") {
    last.text += ev.text;
  } else {
    msg.parts.push({ type: "thinking", text: ev.text });
  }
  await this.flush();
}
```

**Step 4: Run green.** Same command → PASS. Then full package: `pnpm --filter @orden/chat-core test` → all PASS.

**Step 5: Commit.**
```bash
git add packages/chat-core/src/reduceToVault.ts packages/chat-core/test/reduceToVault.test.ts
git commit -m "chat-core: reduce thinking deltas into a thinking part"
```

---

### Task 3: Translate SDK `stream_event` partials into deltas (with dedupe)

This is the core of live streaming. With `includePartialMessages`, the SDK emits `{ type: "stream_event", event: BetaRawMessageStreamEvent }` for token deltas AND still emits the final whole `assistant` message. We must drive text/thinking from the deltas and use the final `assistant` message ONLY for `tool_use` (otherwise text renders twice).

**Files:**
- Modify: `apps/host/src/chat/sdkMessageToEvents.ts`
- Test: `apps/host/test/sdkMessageToEvents.test.ts` (create if absent — check first)

**Step 1: Write the failing test.** Create/extend `apps/host/test/sdkMessageToEvents.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { sdkMessageToEvents } from "../src/chat/sdkMessageToEvents";

// Minimal stand-ins for SDK message shapes (cast through unknown).
const streamEv = (event: unknown) =>
  ({ type: "stream_event", event } as unknown as Parameters<typeof sdkMessageToEvents>[0]);

describe("sdkMessageToEvents stream_event", () => {
  it("maps a text_delta to a text event", () => {
    const out = sdkMessageToEvents(
      streamEv({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } }),
    );
    expect(out).toEqual([{ kind: "text", messageId: expect.any(String), text: "Hi" }]);
  });

  it("maps a thinking_delta to a thinking event", () => {
    const out = sdkMessageToEvents(
      streamEv({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "ponder" } }),
    );
    expect(out).toEqual([{ kind: "thinking", messageId: expect.any(String), text: "ponder" }]);
  });

  it("uses message_start id as the messageId for subsequent deltas", () => {
    sdkMessageToEvents(streamEv({ type: "message_start", message: { id: "msg_abc" } }));
    const out = sdkMessageToEvents(
      streamEv({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } }),
    );
    expect(out).toEqual([{ kind: "text", messageId: "msg_abc", text: "x" }]);
  });

  it("does NOT re-emit text from the final assistant message when partials were streamed", () => {
    sdkMessageToEvents(streamEv({ type: "message_start", message: { id: "msg_abc" } }));
    sdkMessageToEvents(streamEv({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } }));
    const finalAssistant = {
      type: "assistant",
      message: { id: "msg_abc", content: [{ type: "text", text: "Hi" }] },
    } as unknown as Parameters<typeof sdkMessageToEvents>[0];
    const out = sdkMessageToEvents(finalAssistant);
    // text already streamed → no duplicate text event; tool_use (none here) would still pass through
    expect(out.filter((e) => e.kind === "text")).toEqual([]);
  });

  it("still emits tool_use from the final assistant message", () => {
    sdkMessageToEvents(streamEv({ type: "message_start", message: { id: "msg_t" } }));
    const finalAssistant = {
      type: "assistant",
      message: {
        id: "msg_t",
        content: [{ type: "tool_use", id: "t1", name: "Bash", input: { cmd: "ls" } }],
      },
    } as unknown as Parameters<typeof sdkMessageToEvents>[0];
    const out = sdkMessageToEvents(finalAssistant);
    expect(out).toEqual([{ kind: "tool", messageId: "msg_t", toolId: "t1", name: "Bash", input: { cmd: "ls" } }]);
  });
});
```

NOTE: `sdkMessageToEvents` is currently a pure stateless function. Dedupe needs per-stream state (which message ids streamed text). Convert it to a small stateful factory while keeping a default singleton export for callers that don't stream. Check the one caller (`apps/host/src/chat/adapters/claude.ts`, the `yield* sdkMessageToEvents(msg)` line) and update it to use a per-driver instance.

**Step 2: Run red.** `pnpm --filter @orden/host exec vitest run test/sdkMessageToEvents.test.ts`
Expected: FAIL (`stream_event` currently hits `default: return []`).

**Step 3: Implement.** Refactor `sdkMessageToEvents.ts` to a factory that tracks streamed message ids:

```ts
export function createSdkTranslator() {
  let currentMessageId = "";
  const streamedText = new Set<string>(); // message ids whose text came from deltas

  return function translate(msg: SDKMessage): DriverEvent[] {
    switch (msg.type) {
      case "system":
        return msg.subtype === "init"
          ? [{ kind: "session", sessionId: msg.session_id, slashCommands: msg.slash_commands ?? [] }]
          : [];

      case "stream_event": {
        const ev = (msg as unknown as { event: Record<string, unknown> }).event;
        if (ev.type === "message_start") {
          currentMessageId = ((ev.message as { id?: string })?.id) ?? currentMessageId;
          return [];
        }
        if (ev.type === "content_block_delta") {
          const delta = ev.delta as { type?: string; text?: string; thinking?: string };
          if (delta.type === "text_delta" && delta.text) {
            streamedText.add(currentMessageId);
            return [{ kind: "text", messageId: currentMessageId, text: delta.text }];
          }
          if (delta.type === "thinking_delta" && delta.thinking) {
            return [{ kind: "thinking", messageId: currentMessageId, text: delta.thinking }];
          }
        }
        return [];
      }

      case "assistant": {
        const out: DriverEvent[] = [];
        const messageId = msg.message.id;
        const content = msg.message.content;
        if (!Array.isArray(content)) return out;
        const textAlreadyStreamed = streamedText.has(messageId);
        for (const block of content as unknown as Array<Record<string, unknown>>) {
          if (block.type === "text") {
            if (!textAlreadyStreamed) out.push({ kind: "text", messageId, text: block.text as string });
          } else if (block.type === "tool_use") {
            out.push({ kind: "tool", messageId, toolId: block.id as string, name: block.name as string, input: block.input });
          }
        }
        return out;
      }

      case "user": {
        const content = msg.message.content;
        if (!Array.isArray(content)) return [];
        const out: DriverEvent[] = [];
        for (const block of content as unknown as Array<Record<string, unknown>>) {
          if (block.type === "tool_result") {
            out.push({ kind: "tool-result", toolId: block.tool_use_id as string, output: stringifyToolContent(block.content), ok: !block.is_error });
          }
        }
        return out;
      }

      case "result":
        return [{ kind: "turn-end" }];

      default:
        return [];
    }
  };
}

// Back-compat singleton for any non-streaming caller/test.
export const sdkMessageToEvents = createSdkTranslator();
```

Keep `stringifyToolContent` and the `ToolResultPart` interface as-is above the factory.

NOTE on the test: because the back-compat singleton is shared, the dedupe tests that depend on prior `message_start` state must use ONE singleton consistently (they do, via the module export). If cross-test bleed appears, switch the tests to `const translate = createSdkTranslator()` per test.

**Step 4: Run green.** Same command → PASS. Then `pnpm --filter @orden/host typecheck`.

**Step 5: Update the adapter caller.** In `apps/host/src/chat/adapters/claude.ts`, replace the module-level `sdkMessageToEvents` use inside the `events()` generator with a per-driver instance:

```ts
const translate = createSdkTranslator();
async function* events(): AsyncGenerator<DriverEvent, void> {
  try {
    for await (const msg of q) {
      yield* translate(msg);
    }
  ...
```

Add `createSdkTranslator` to the import from `../sdkMessageToEvents`.

**Step 6: Commit.**
```bash
git add apps/host/src/chat/sdkMessageToEvents.ts apps/host/test/sdkMessageToEvents.test.ts apps/host/src/chat/adapters/claude.ts
git commit -m "host: stream SDK partial messages into text/thinking deltas with dedupe"
```

---

### Task 4: Turn on partial messages

**Files:**
- Modify: `apps/host/src/chat/adapters/claude.ts` (the `options` object, ~line 128)

**Step 1: Implement.** Add to the `Options` object:

```ts
const options: Options = {
  model,
  permissionMode: "default",
  settingSources: [],
  canUseTool,
  abortController,
  includePartialMessages: true,
};
```

**Step 2: Typecheck.** `pnpm --filter @orden/host typecheck` → PASS (the option exists in `@anthropic-ai/claude-agent-sdk@0.2.126`, sdk.d.ts:1365).

**Step 3: Verify the contract test still passes.** `pnpm --filter @orden/host test` and `pnpm --filter @orden/chat-core test` → PASS. (If `packages/chat-core/src/testing/adapterContract.ts` asserts event ordering, confirm thinking-before-text ordering matches what the real stream emits; adjust the contract only if it explicitly enumerates kinds.)

**Step 4: Commit.**
```bash
git add apps/host/src/chat/adapters/claude.ts
git commit -m "host: enable includePartialMessages for live Claude streaming"
```

---

### Task 5: Render a thinking part in the chat view

**Files:**
- Modify: `packages/chat-ui/src/chatView.ts` (the `renderMessage` part loop, ~line 629)
- Test: `packages/chat-ui/test/chatView.test.ts`

**Step 1: Write the failing test.** Add to `chatView.test.ts` (follow the existing test that mounts a view and inspects DOM):

```ts
it("renders a thinking part as a dimmed collapsible block", () => {
  // hydrate a store with a message carrying a thinking part, mount, assert DOM
  // (mirror the existing chatView test's mount harness)
  // expect a .chat-thinking element whose text contains the thinking text
});
```

Fill in using the file's existing mount helper and assertion idiom.

**Step 2: Run red.** `pnpm --filter @orden/chat-ui exec vitest run test/chatView.test.ts -t "thinking"`
Expected: FAIL (no thinking rendering today; the part loop only handles text/tool).

**Step 3: Implement.** In `renderMessage`'s part loop, add a branch for `part.type === "thinking"` that appends a dimmed block (a `<details>` collapsed by default, or a `div.chat-thinking`). Add a matching style if the package ships CSS.

**Step 4: Run green.** Same command → PASS, then `pnpm --filter @orden/chat-ui test`.

**Step 5: Commit.**
```bash
git add packages/chat-ui/src/chatView.ts packages/chat-ui/test/chatView.test.ts
git commit -m "chat-ui: render thinking parts"
```

---

## Phase B — Settings grid

### Task 6: Settings model — `defaultMode` + `showScratchTerminal`

**Files:**
- Modify: `apps/web/src/settings.ts`
- Test: `apps/web/test/settings.test.ts` (check it exists; if not, create)

**Step 1: Write the failing test.** Assert defaults and coercion:

```ts
it("defaults defaultMode to tui for both tools and showScratchTerminal to true", () => {
  const s = coerceForTest({}); // see note
  expect(s.defaultMode).toEqual({ claude: "tui", opencode: "tui" });
  expect(s.showScratchTerminal).toBe(true);
});

it("accepts a valid defaultMode and rejects garbage", () => {
  expect(coerceForTest({ defaultMode: { claude: "gui", opencode: "tui" } }).defaultMode)
    .toEqual({ claude: "gui", opencode: "tui" });
  expect(coerceForTest({ defaultMode: { claude: "nonsense" } }).defaultMode)
    .toEqual({ claude: "tui", opencode: "tui" });
});
```

`coerce` is currently module-private. Either export it as `coerce` for the test, or test through `hydrateSettings` + `loadSettings` with a stub host. Prefer exporting `coerce` (small, harmless).

**Step 2: Run red.** `pnpm --filter @orden/web exec vitest run test/settings.test.ts` → FAIL.

**Step 3: Implement.** In `settings.ts`:
- Add to `Settings`: `defaultMode: { claude: SessionMode; opencode: SessionMode };` and `showScratchTerminal: boolean;` where `export type SessionMode = "tui" | "gui";`
- Add to `DEFAULT_SETTINGS`: `defaultMode: { claude: "tui", opencode: "tui" }, showScratchTerminal: true,`
- Add a validator and coerce branch:

```ts
function isMode(v: unknown): v is SessionMode { return v === "tui" || v === "gui"; }
function coerceMode(v: unknown): Settings["defaultMode"] {
  const o = (typeof v === "object" && v ? v : {}) as Record<string, unknown>;
  return {
    claude: isMode(o.claude) ? o.claude : "tui",
    opencode: isMode(o.opencode) ? o.opencode : "tui",
  };
}
```
In `coerce(...)` return object add:
```ts
defaultMode: coerceMode(s.defaultMode),
showScratchTerminal: typeof s.showScratchTerminal === "boolean" ? s.showScratchTerminal : DEFAULT_SETTINGS.showScratchTerminal,
```
Export `coerce` (or a thin `coerceForTest`).

**Step 4: Run green.** Same command → PASS.

**Step 5: Commit.**
```bash
git add apps/web/src/settings.ts apps/web/test/settings.test.ts
git commit -m "web: settings model for defaultMode grid + scratch terminal toggle"
```

---

### Task 7: Settings popover — the 2×2 grid + scratch toggle

**Files:**
- Modify: the settings popover render (grep `apps/web/src` for an existing control like `sessionAutoLaunch` to find where the popover DOM is built — likely `main.ts` or a `renderSettings`/settings-popover function).
- Test: DOM test alongside the popover, or a focused unit test of the grid builder if you extract one.

**Step 1: Locate.** `grep -rn "sessionAutoLaunch\|completeFadeHours" apps/web/src` → the popover render site. Read its idiom (how it builds toggles, how it calls `saveSettings`).

**Step 2: Write the failing test** for grid behavior: rendering the grid shows two rows (Claude Code, opencode), each with TUI/GUI radios reflecting current settings; selecting GUI for Claude calls `saveSettings({ defaultMode: { claude: "gui", opencode: ... } })`. Extract a small `buildModeGrid(settings, onChange)` pure-ish DOM builder so it's testable without the whole popover.

**Step 3: Run red → implement → green.** Build `buildModeGrid` (plain DOM matching the existing controls), wire it into the popover, and add a checkbox for `showScratchTerminal` next to the other booleans.

**Step 4: Commit.**
```bash
git add apps/web/src/<popover-file>.ts apps/web/src/settings.ts apps/web/test/<grid-test>.ts
git commit -m "web: settings popover mode grid + scratch terminal toggle"
```

---

## Phase C — mode on the session + creation + panel surface

### Task 8: Add `mode` to the Session types

**Files:**
- Modify: `packages/host-api/src/index.ts` (the `Session` interface, ~line 101)
- Modify: `apps/web/src/sessions.ts` (the web `Session` type, if separately declared)
- `apps/host/src/terminal.ts` `SessionRecord` already has `[k: string]: unknown`, so no change needed there.

**Step 1: Implement.** Add to `Session`:
```ts
/** Surface this session opens in. Absent = legacy (both tabs, terminal default). */
mode?: "tui" | "gui";
```
Mirror on the web `Session` type if it's a separate declaration.

**Step 2: Typecheck.** `pnpm -r typecheck` → PASS.

**Step 3: Commit.**
```bash
git add packages/host-api/src/index.ts apps/web/src/sessions.ts
git commit -m "host-api: add session mode (tui|gui)"
```

---

### Task 9: Stamp `mode` at creation; GUI skips tmux launch

**Files:**
- Modify: `apps/web/src/sessions.ts` (`createSession`, ~line 227)
- Test: `apps/web/test/sessions.test.ts` (or wherever createSession is covered; create a focused test)

**Step 1: Write the failing test.** With a stubbed settings cache (`defaultMode.claude = "gui"`), `createSession({ agent: "claude", title: "t" })` returns a session with `mode: "gui"`, and the vault write for a GUI session does NOT include `pendingLaunch: true` (GUI launches lazily on Chat mount). For a TUI agent it DOES set `pendingLaunch`.

**Step 2: Run red.**

**Step 3: Implement.** In `createSession`:
- Import `loadSettings` from `./settings`.
- `const mode = loadSettings().defaultMode[opts.agent];`
- Add `mode` to the `session` object.
- Branch the launch write:
```ts
if (host) {
  if (mode === "gui") {
    void host.vault.set("sessions", session.id, session); // no tmux; Chat mount launches the agent
  } else {
    void host.vault.set("sessions", session.id, { ...session, pendingLaunch: true });
  }
}
```

**Step 4: Run green.**

**Step 5: Commit.**
```bash
git add apps/web/src/sessions.ts apps/web/test/sessions.test.ts
git commit -m "web: stamp session mode from settings; GUI sessions skip tmux launch"
```

---

### Task 10: Launch reactor respects GUI mode

**Files:**
- Modify: `apps/host/src/serve.ts` (`maybeLaunch`, lines 52-69)
- Test: a focused unit test for `maybeLaunch`'s branch is hard (it spawns tmux). Instead add a guard test if `maybeLaunch` is exported, or rely on the web-side test from Task 9 + a manual check.

**Step 1: Implement.** In `maybeLaunch`, after fetching `rec`, bail for GUI sessions so an MCP-or-legacy `pendingLaunch` on a GUI session never spawns tmux:

```ts
const rec = await host.vault.get<{ pendingLaunch?: boolean; conversationId?: string; mode?: string }>("sessions", sessionId);
if (!rec?.pendingLaunch) return;
if (rec.mode === "gui") {
  const { pendingLaunch: _drop, ...rest } = rec;
  await host.vault.set("sessions", sessionId, rest); // clear the flag, do NOT launch tmux
  return;
}
```

**Step 2: Typecheck + full host test.** `pnpm --filter @orden/host typecheck && pnpm --filter @orden/host test` → PASS.

**Step 3: Commit.**
```bash
git add apps/host/src/serve.ts
git commit -m "host: launch reactor skips tmux for GUI-mode sessions"
```

---

### Task 11: Sessions panel renders only the mode's surface

**Files:**
- Modify: `apps/web/src/sessionsPanel.ts` (tab logic, ~lines 281-330)
- Test: `apps/web/test/sessionsPanel.test.ts` (create or extend)

**Step 1: Write the failing test.** Given a session with `mode: "gui"`, the rendered panel shows the Chat surface and no Terminal tab; `mode: "tui"` shows Terminal and no Chat tab; absent `mode` keeps today's behavior (both, terminal default). Mirror the existing panel test harness.

**Step 2: Run red.**

**Step 3: Implement.** Derive the initial/available surfaces from `s.mode`:
- `mode === "gui"`: only the Chat tab (require `deps.mountChat`; if absent, see Task-fallback note below). `activeTab = "chat"`.
- `mode === "tui"`: only the Terminal tab. `activeTab = "terminal"`.
- `mode == null`: current behavior (both tabs when `mountChat` present, default terminal).

Gate the tab buttons' presence on the mode, not just `chatAvailable`.

Fallback (no chat backend, e.g. BrowserHost) for a GUI session: show the Terminal with a one-line "GUI unavailable on this host" notice rather than an empty panel.

**Step 4: Run green.**

**Step 5: Commit.**
```bash
git add apps/web/src/sessionsPanel.ts apps/web/test/sessionsPanel.test.ts
git commit -m "web: sessions panel shows only the session's mode surface"
```

---

### Task 12: GUI mount uses the streaming agent path (not the mirror)

**Files:**
- Modify: `apps/web/src/chatMount.ts` (the mirror-vs-agent decision, lines 69-109)
- Test: extend a chatMount test if one exists; otherwise a focused test of the branch predicate.

**Step 1: Implement.** When `panelSession.mode === "gui"`, skip the `terminalChat.mirror(...)` path entirely and take the `agentClient` branch, threading the session's project cwd into `createSession` (resolve via the host's project cwd rather than `filesRoot` when available). Keep the existing mirror path for legacy (`mode == null`) sessions.

```ts
const forceAgent = panelSession.mode === "gui";
let mirrored = !forceAgent && host.terminalChat
  ? await host.terminalChat.mirror(panelSession.id)
  : false;
if (!forceAgent && !mirrored && host.terminalChat) {
  // existing wait-for-mirror retry loop, unchanged
}
```

**Step 2: Typecheck + web test.** `pnpm --filter @orden/web typecheck && pnpm --filter @orden/web test` → PASS.

**Step 3: Commit.**
```bash
git add apps/web/src/chatMount.ts
git commit -m "web: GUI sessions mount the streaming agent path, not the mirror"
```

---

### Task 13: GUI session card state from turn boundaries

Status: IMPLEMENTED (the explicit-callback path, not a vault-inference reactor). Two sites: `packages/chat-core/src/engine.ts` gained an optional `onTurnBoundary(sessionId, "start"|"end")` (fires "start" on the first non-`session` driver event after idle, "end" on `turn-end`, re-arming each turn). `apps/host/src/nodeHost.ts` wires it into `createChatBackend`, routing through `applyChatTurnBoundary` in `apps/host/src/hooks.ts`, which reverse-maps the chat session id to the orden session id via the `chat-link` vault ns and calls the existing `applyStateBySessionId` (so the never-clobber-complete guard is reused, not reimplemented). start → `in-progress`, end → `blocked`. `serve.ts` was not touched — the callback is constructed alongside the engine.

GUI sessions have no tmux, so the injected claude hooks that drive kanban state never fire. Drive card state from the chat engine instead, reusing the existing `/hooks/session-state` semantics (in-progress on activity, blocked on turn-end).

**Files:**
- Modify: `apps/host/src/serve.ts` — add a reactor on `chat:<id>` changes, OR wire an engine turn-boundary callback. Simplest reuse: a reactor that, for a GUI session, posts the same state transitions the hooks do.
- Test: focused test of the mapping function (pure), plus manual verification.

**Step 1: Decide the trigger.** The chat engine writes `meta` and `msg:<seq>` to `chat:<sessionId>`. A `turn-end` closes the open message. Use a host reactor: on a `chat:<id>` `msg:*` write for a GUI session, set the card to `in-progress`; on the engine's `turn-end` (detected via a small marker the reducer/engine can set, or by the absence of an open streaming message), set `blocked`. If detecting turn-end from vault state is fragile, add an optional `onTurnBoundary(sessionId, "start"|"end")` callback to the chat engine (`engine.ts`) and have the host wire it to the existing card-state code path.

Prefer the explicit callback — it is deterministic, unlike inferring from vault writes (see the idle-reconciler safety net memory for why inference is fragile).

**Step 2: Write the failing test** for the mapping (callback "start" → in-progress, "end" → blocked) without spawning a real agent.

**Step 3: Implement** the callback in `engine.ts` (invoke on first event of a turn and on `turn-end`), and wire it in the host where the GUI engine is constructed, calling the same internal that `/hooks/session-state` uses.

**Step 4: Run green + full host test.**

**Step 5: Commit.**
```bash
git add apps/host/src/chat/engine.ts apps/host/src/serve.ts apps/host/test/*
git commit -m "host: drive GUI session kanban state from chat turn boundaries"
```

> If this task balloons, STOP and split it — board integration for GUI can ship as a fast-follow without blocking the streaming + grid demo. Note the cut explicitly per the design.

---

## Phase D — Scratch terminal

### Task 14: `/term` scratch branch (plain shell)

**Files:**
- Modify: `apps/host/src/terminal.ts` (`handle`, ~line 411, and the tmux spawn ~line 466)
- Test: a unit test of a small extracted helper that decides scratch-vs-agent from the URL, plus manual verification of the shell launch.

**Step 1: Write the failing test.** Extract `function isScratchReq(url: URL): boolean` (true when `url.searchParams.get("scratch") === "1"` or `url.searchParams.get("session") === "scratch"`), and test it.

**Step 2: Run red → implement.** In `handle`, branch before the `rec` lookup:

```ts
const url = new URL(req.url ?? "", "http://localhost");
if (isScratchReq(url)) {
  const cols = Number(url.searchParams.get("cols")) || 80;
  const rows = Number(url.searchParams.get("rows")) || 24;
  const shell = process.env.SHELL || "/bin/bash";
  const term = ptySpawn("tmux", [
    "new-session", "-A", "-s", "orden-scratch", "-c", defaultCwd, shell,
  ], { name: "xterm-color", cols, rows, cwd: defaultCwd, env: process.env as Record<string, string> });
  // wire term <-> socket using the SAME pipe logic the agent path uses below
  return;
}
```
Reuse the existing socket<->pty piping (factor it out if needed so scratch and agent share it). `-A` makes `orden-scratch` attach-or-create (single reattachable shell).

**Step 3: Run green** (the helper test) + `pnpm --filter @orden/host typecheck`.

**Step 4: Manual check.** Start the host (`pnpm --filter @orden/host exec tsx apps/host/src/serve.ts`), open a WS to `/term?scratch=1&cols=80&rows=24`, confirm a shell prompt and that reconnecting reattaches the same session (`tmux ls` shows `orden-scratch`).

**Step 5: Commit.**
```bash
git add apps/host/src/terminal.ts apps/host/test/terminal*.test.ts
git commit -m "host: /term scratch branch launches a reattachable plain shell"
```

---

### Task 15: Scratch terminal button + setting gate

**Files:**
- Modify: `apps/web/src/sessionsPanel.ts` (panel header — add a `>_` button)
- Modify: `apps/web/src/terminalView.ts` (allow mounting against `session=scratch`/`scratch=1`; it builds the `/term?session=...` URL at line 60 — add a scratch variant)
- Test: panel test asserting button visibility tracks `showScratchTerminal`.

**Step 1: Write the failing test.** With `showScratchTerminal: true` the panel header renders the scratch button; with `false` it does not. Clicking it mounts a terminal view pointed at the scratch URL (assert the URL or a passed flag).

**Step 2: Run red → implement.**
- `terminalView.ts`: accept a `scratch` option (or a reserved `sessionId === "scratch"`) and build `/term?scratch=1&cols=...&rows=...`.
- `sessionsPanel.ts`: render a header button gated by `loadSettings().showScratchTerminal`; on click, mount the scratch terminal into the panel body as a transient surface (not a selected session), with a close affordance returning to the prior session.

**Step 3: Run green** + `pnpm --filter @orden/web test`.

**Step 4: Commit.**
```bash
git add apps/web/src/sessionsPanel.ts apps/web/src/terminalView.ts apps/web/test/sessionsPanel.test.ts
git commit -m "web: scratch terminal button gated by showScratchTerminal"
```

---

## Phase E — Integration & verification

### Task 16: Full verification + manual streaming check

**Step 1: Whole-repo gates.**
```bash
pnpm -r typecheck
pnpm -r test
```
Expected: all PASS.

**Step 2: Build + run.**
```bash
pnpm --filter @orden/web build
pnpm --filter @orden/host exec tsx apps/host/src/serve.ts
```

**Step 3: Manual acceptance** (the symptoms that started this):
- Settings → set Claude = GUI. Create a Claude session. It opens the Chat surface only (no Terminal tab), and **text + thinking stream live token-by-token** (not after-the-fact).
- Send a message mid-turn → it appears immediately and does not vanish (the chatStore optimistic-echo fix already landed on main; confirm it's present here).
- Set Claude = TUI → a new Claude session opens the Terminal only.
- opencode GUI streams (already did via OpencodeMirror).
- Scratch terminal button appears (toggle hides it), opens a shell, reattaches on reconnect.
- A legacy session (no `mode`) still shows both tabs.

@superpowers:verification-before-completion — paste the actual command output; do not claim green without it.

**Step 4: Finish the branch.** Use @superpowers:finishing-a-development-branch to choose merge/PR/cleanup.

---

## Notes & risks

- **Dedupe is the sharpest edge** (Task 3). If text double-renders, the `streamedText` set isn't shared with the final-assistant branch — confirm both run on the same translator instance per driver.
- **adapterContract test** may enumerate event kinds/order; widen it for `thinking` only if it explicitly asserts the set.
- **Task 13 (GUI card state)** is the most likely to overrun — it's allowed to become a fast-follow; if so, log the cut.
- **BrowserHost** has no chat backend; GUI mode must degrade (Task 11 fallback), since the grid is visible there too.
- Per the repo: 100% test pass before moving between phases; rebuild `dist` to see web changes (no HMR).
