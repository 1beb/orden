# ADR-0012: Chat backend with pluggable harness registry

**Date:** 2026-06-02
**Status:** accepted

## Context

Orden needs a native HTML Chat tab that streams agent turns, renders markdown and
tool-call cards, supports tool-permission approval, and works across both Claude
Code and opencode — without per-harness UI forks. A 2026-06-01 spike proved the
Claude SDK backend; a 2026-06-02 research pass confirmed no existing multi-harness
frontend exists.

## Discussed in

Conversation `9230dba3-76ce-4af2-8beb-29a311b767da` (2026-06-02):

> "We discussed UI for chat instead of tmux. Where did we leave off?"

A deep-research pass confirmed no existing frontend was both multi-harness and
mature. The user directed: "Borrow concepts from opencode web please." The
critical modularity requirement came later in the same session:

> "Let's make sure that this claude/opencode agnostic ui is it's own package,
> let's also make sure that the design is modular, in the sense that we have a
> unified front end but backend protocols that can be added - I can see a future
> where we want to add more harnesses."

This feedback drove the design from "two concrete backend implementations" to
"one generic engine over a pluggable registry."

## Decision

**Build a generic chat engine over a pluggable harness adapter registry.
Normalize all harness output into a single DriverEvent stream reduced to the
vault. The UI depends only on chat-core types, never on a specific harness SDK.**

Architecture:

- **`@orden/chat-core`** (pure TS, no Node, no DOM): defines the normalized types
  (`ChatSession`, `ChatMessage`, `ChatPart`, `DriverEvent`), the
  `HarnessAdapter`/`HarnessDriver` interfaces, an adapter registry, a
  `VaultReducer` that folds DriverEvents into `chat:<sessionId>` vault writes,
  and a generic `ChatBackend` engine.
- **`@orden/chat-ui`** (vanilla DOM, framework-free): `chatStore` (hydrates from
  vault, applies change-feed deltas), `chatView` (renders messages to parts),
  command palette, model picker. Depends only on chat-core types + a `ChatClient`
  interface.
- **Adapters** live in `apps/host/src/chat/adapters/` — one file per harness,
  each implementing `HarnessAdapter`. Claude wraps the
  `@anthropic-ai/claude-agent-sdk`; opencode wraps the serve HTTP+SSE API.
  Adding a harness = one adapter file + one register call. The engine, UI, and
  every other package are untouched.
- Permission model normalized: Claude is a pull (`canUseTool` must return
  allow/deny), opencode is a push (bus event + POST). Both surface through
  `driver.onPermission`. The engine mints a PermissionRequest, writes it to the
  vault, and parks a resolver — the UI is identical for both harnesses.
- Streaming is vault-backed, not a direct callback: parts are written to the
  vault; orden's existing `host.onChange` feed streams them to the web store.
  Resume falls out for free: `getMessages` replays history, the feed delivers
  new parts.

**Rejected alternatives:**

- **Per-harness UI implementations.** Would fork the Chat renderer and double
  maintenance cost.
- **Building on opencode-web's UI directly.** opencode-web is single-harness; the
  multi-harness requirement demands an abstraction layer.
- **Agent Client Protocol (ACP).** Only alpha implementations exist; not mature
  enough to target.
- **Direct streaming callback instead of vault-backed.** Would require a separate
  streaming transport. The vault + change feed is already the app's reactive
  backbone — reusing it keeps the architecture uniform.

## Consequences

**Easier:**

- Adding a new AI harness is one adapter file — the engine, UI, and all other
  packages are untouched by the addition.
- The UI is harness-agnostic by construction; it never imports a harness SDK.
- Permission handling is normalized: one UI path for both Claude and opencode,
  despite their different underlying mechanisms (pull vs push).
- The adapter contract test is a self-testing gate: any new harness must pass it
  to be considered done.

**Harder:**

- The normalized event model is a least-common-denominator abstraction that must
  be maintained as harnesses evolve — divergence in capabilities means the
  abstraction may need widening.
- Vault-backed streaming means the UI is eventually-consistent with the agent
  process, not directly coupled. A vault write delay or batch is a perceived
  lag.
- The chat engine is a long-lived process per session — managing its lifecycle
  (start, error, close, resume) is more complex than a stateless per-turn spawn.
