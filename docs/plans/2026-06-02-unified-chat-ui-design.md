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

Host-side, one interface, two implementations.

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

## Backends

`ClaudeChatBackend` holds one long-lived `query()` per session (an
`AsyncIterable` prompt in streaming-input mode, required for `setModel` and
multi-turn). It maps `assistant` messages to text and tool parts, the
`system/init` message to the session id and `slash_commands`, and the `result`
message to turn end. `options.model`/`fallbackModel` are set at start;
`q.setModel(...)` switches at runtime; `q.supportedCommands()` lists commands.
Isolation flags from the spike are retained: `permissionMode:'default'`,
`settingSources:[]`.

`OpencodeChatBackend` ensures a project-scoped `opencode serve` child, subscribes
to `GET /event` (SSE) and maps `message.updated`/`part.updated` to parts. It uses
`session.create`/`session.prompt`/`session.command`, and `config.providers()` for
the model catalog. Resume re-fetches the session and its messages.

### Permission asymmetry

Claude permissions are a pull: `canUseTool(name, input, opts)` must return a
promise resolving to allow/deny. opencode permissions are a push: a bus event
plus `POST /session/:id/permissions/:permissionID`. Both normalize to a minted
`PermissionRequest{id}` written to the vault. The UI calls
`respondPermission(id, decision)`. For Claude, the backend parks the `canUseTool`
resolver in a map keyed by that id and resolves it on response. For opencode, it
POSTs. Same UI, same vault shape, two hidden mechanisms.

## Web UI

Vanilla TS (orden's `apps/web` stack), borrowing opencode-web patterns.

A `chatStore` hydrates from `getMessages` (resume) and applies change-feed deltas
as atomic part mutations. `chatView.ts` renders messages to parts: text through
the existing markdown path, tool parts as collapsible cards (name, input,
streamed output, state), permission requests as inline allow/deny controls. A
`/`-triggered command palette is populated from `listCommands`; a model picker
from `listModels` is bound to `createSession` and `setModel`.

## Placement

- `packages/host-api`: `ChatBackend` types, alongside `SessionManager`.
- `apps/host`: `claudeChatBackend.ts`, `opencodeChatBackend.ts` (node-only).
- `apps/web`: `chatStore.ts`, `chatView.ts`, plus the Chat tab wiring.
- `BrowserHost`: a no-op/error stub, as it already does for real sessions.

## Testing

1. One shared contract test both backends pass: create, send, stream parts,
   permission round-trip, resume, setModel.
2. Per-backend mapping unit tests against recorded fixtures (Claude message to
   parts; opencode SSE event to parts), no live process.
3. Web `chatStore` reducer tests (feed delta to state).

UI rendering stays thin and is manually verified by running the real app at the
end, per the show-don't-narrate rule.

## Build order

Types, then Claude backend, then opencode backend, then the shared contract test
green, then wire the feed, then the Chat tab, then run it.
