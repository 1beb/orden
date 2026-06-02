# Unified Chat UI design

Date: 2026-06-02

## Problem

orden runs real agent sessions, but the only way to interact with them is the
interactive TUI (claude/opencode) rendered in tmux over `/term`. That terminal
path is fragile on mobile (scroll), gives no structured rendering of tool calls,
and exposes no native UI for permission prompts, slash commands, or model
selection. We want a native HTML Chat tab that sits alongside the Terminal tab:
it streams agent turns, renders markdown and tool-call cards, prompts for
tool-permission approval, supports multi-turn and resume, and works across both
harnesses (Claude Code, opencode).

A 2026-06-01 spike proved the Claude backend via `@anthropic-ai/claude-agent-sdk`
`query()` (stream a turn, multi-turn send, resume, `canUseTool` approve/deny). A
2026-06-02 research pass confirmed no existing frontend is both multi-harness and
mature; the strongest reuse path is to build directly on the two documented
backend protocols (opencode serve API, Claude Agent SDK) and borrow concepts from
opencode-web's UI. This document is that build.

## Non-goals

- Replacing the Terminal tab. The real tmux TUI stays, unchanged.
- One-shot `claude -p`. Still banned. The Chat backend is a persistent
  streaming process, not a per-turn spawn.
- Agent Client Protocol (ACP). Tracked as a future cross-harness standard, not
  targeted now (only alpha implementations exist).
- Virtual scrolling. Deferred until transcript size demands it.

## Normalized model

Both Claude SDK messages and opencode SSE events collapse into one model,
borrowing opencode-web's parts concept (a message is an ordered list of async
parts).

```
ChatSession  = { id, title, harness: 'claude'|'opencode', cwd, model?, createdAt }
ChatMessage  = { id, role: 'user'|'assistant', parts: ChatPart[] }
ChatPart     =
  | { type:'text', text }
  | { type:'tool', toolId, name, input, state:'pending'|'running'|'done'|'error', output? }
PermissionRequest = { id, toolName, input, title }
ModelOption  = { harness, id, label }          // id is opaque; backend translates
SlashCommand = { name, description? }
```

`model.id` is opaque to the UI. For Claude it is the model string (e.g.
`claude-opus-4-8`, including variants like `claude-opus-4-8[1m]`); for opencode
it encodes `providerID/modelID`. The backend translates it back to the native
form. Variants are simply distinct `ModelOption`s in the catalog.

## ChatBackend interface

The public surface, implemented once by a generic engine over a harness-adapter
registry (see Engine and adapters below).

```
listSessions()                              -> ChatSession[]
createSession({ harness, cwd, title?, model? }) -> ChatSession
getMessages(sessionId)                      -> ChatMessage[]    // history = resume
send(sessionId, text, { model? })           -> void             // text may be "/command"
respondPermission(sessionId, reqId, { decision:'allow'|'deny', remember? })
setModel(sessionId, model)                  -> void             // runtime switch
listModels(harness)                         -> ModelOption[]
listCommands(sessionId)                     -> SlashCommand[]
```

There is no streaming method on the interface. Parts and permission-requests are
written into the vault (ns `chat:<sessionId>`); orden's existing `host.onChange`
feed streams them to the web store. The backend is a writer, the UI a reader.
Resume falls out for free: `getMessages` replays history, the feed delivers new
parts. This is opencode-web's "direct-to-store SSE", expressed in orden's spine.

## Engine and adapters (the extension point)

`ChatBackend` is implemented **once**, generically, as an engine over a registry
of harness adapters. There is no per-harness backend class. Adding a harness is
adding one adapter and one registry line; the engine, the UI, and every other
package are untouched. This is the modularity requirement made concrete.

A `HarnessDriver` is a per-session live connection that emits one normalized
event stream and accepts control calls:

```
type DriverEvent =
  | { kind:'session', sessionId, slashCommands: string[] }
  | { kind:'text', messageId, text }
  | { kind:'tool', messageId, toolId, name, input }
  | { kind:'tool-result', toolId, output, ok }
  | { kind:'turn-end' }

interface HarnessDriver {
  events: AsyncIterable<DriverEvent>
  send(text): Promise<void>             // text may be "/command"
  setModel(model): Promise<void>
  listCommands(): Promise<SlashCommand[]>
  onPermission(cb): void                // driver calls cb to ask; cb resolves allow/deny
  close(): Promise<void>
}

interface HarnessAdapter {
  harness: string                       // 'claude' | 'opencode' | future
  listModels(): Promise<ModelOption[]>
  open(opts: { cwd, model? }): HarnessDriver
}
```

Adapters register into a registry (`registerAdapter(adapter)`); the engine looks
one up by `session.harness`. The engine owns all harness-agnostic work: it pipes a
driver's `events` through `reduceToVault` (the one reducer that turns
`DriverEvent`s into `chat:<sessionId>` writes), parks permission resolvers, and
delegates `send`/`setModel`/`listCommands`/`listModels` to the driver/adapter.

The two adapters differ only inside `open()`:

- claude adapter wraps `@anthropic-ai/claude-agent-sdk` `query()` (streaming-input
  mode; `permissionMode:'default'`, `settingSources:[]` per the spike). Maps
  `system/init`→`session`, `assistant`→`text`/`tool`, results→`tool-result`,
  `result`→`turn-end`. `canUseTool` drives `onPermission` (the pull).
- opencode adapter ensures a project-scoped `opencode serve` child, maps SSE
  `message.updated`/`part.updated` to the same `DriverEvent`s, uses
  `session.create/prompt/command` and `config.providers()` for models, and
  surfaces the permission bus event through `onPermission`, answering via
  `POST /session/:id/permissions/:permissionID` (the push).

### Permission asymmetry, normalized

Claude is a pull (`canUseTool` must return allow/deny); opencode is a push (bus
event + POST). Both surface through the driver's `onPermission`. The engine mints
a `PermissionRequest{id}`, writes it to the vault, and parks the resolver in a map
keyed by that id. `respondPermission(id, decision)` resolves the parked promise
(claude) or POSTs (opencode). Same UI, same vault shape, hidden mechanism.

## Frontend (`@orden/chat-ui`)

Its own framework-free package — vanilla TS DOM, borrowing opencode-web patterns,
with zero knowledge of any harness or of the host transport. It depends only on
`@orden/chat-core` types plus a small `ChatClient` interface (the methods it
calls). `apps/web` supplies a concrete `ChatClient` (over the host RPC) and the
change feed; the package itself is reusable and host-agnostic.

A `chatStore` hydrates from `getMessages` (resume) and applies change-feed deltas
as atomic part mutations. `chatView` renders messages to parts: text through a
markdown renderer, tool parts as collapsible cards (name, input, streamed output,
state), permission requests as inline allow/deny controls. A `/`-triggered command
palette is populated from `listCommands`; a model picker from `listModels` is
bound to `createSession` and `setModel`.

## Packages

The harness-agnostic core and the frontend are their own packages, reusable and
free of any host/node/DOM coupling. Only the adapters carry harness SDKs.

- `@orden/chat-core` (new, pure TS — no node, no DOM): the types (`ChatSession`,
  `ChatMessage`, `ChatPart`, `PermissionRequest`, `ModelOption`, `SlashCommand`),
  `DriverEvent`, the `HarnessAdapter`/`HarnessDriver` interfaces, the adapter
  registry, `reduceToVault`, and the generic `ChatBackend` engine. The heart;
  fully unit-testable anywhere.
- `@orden/chat-ui` (new, framework-free DOM — no node): `chatStore`, `chatView`,
  command palette, model picker. Depends on `@orden/chat-core` + the `ChatClient`
  interface only.
- `apps/host/src/chat/adapters/{claude,opencode}.ts`: each implements
  `HarnessAdapter`, self-contained (depends only on `@orden/chat-core` + its own
  SDK), registered once. Adding a harness = a new file here + one register call.
  Promotable to standalone `@orden/chat-adapter-*` packages later; the layout
  already isolates each one so the promotion is a move, not a rewrite.
- `apps/host`: instantiates the engine with the registered adapters and the
  emitting vault; `wsServer` proxies the `ChatBackend` RPC.
- `apps/web`: mounts `@orden/chat-ui`, supplies the `ChatClient` (RPC) and wires
  `onVaultChange`. Thin glue only.
- `BrowserHost`: a `chat` stub (no adapters), as it already stubs real sessions.

`Host.chat` is typed from `@orden/chat-core` (re-exported through `@orden/host-api`
so no types are duplicated).

## Testing

1. `@orden/chat-core`: `reduceToVault` reducer tests (DriverEvent → vault writes:
   text append, tool state transitions, out-of-order parts, turn-end) and engine
   tests (permission park/resolve, resume, delegation).
2. **One adapter contract test** every `HarnessAdapter` must pass, run against
   each adapter's scripted fake driver — the proof the abstraction is real and the
   gate a future harness must clear to be considered done.
3. Live adapters: one env-gated smoke test each (`ORDEN_LIVE_CLAUDE=1` /
   `ORDEN_LIVE_OPENCODE=1`), skipped in CI.
4. `@orden/chat-ui`: `chatStore` reducer tests (feed delta → state). View
   rendering stays thin and is manually verified by running the real app.

## Build order

`@orden/chat-core` types → `reduceToVault` + engine → adapter contract test → claude
adapter → opencode adapter (both pass the contract) → host wiring (`Host.chat`,
RPC) → `@orden/chat-ui` → mount in `apps/web` → run it.
