# opencode card state from session.status (fix premature "blocked")

Date: 2026-06-22

## Problem

opencode sessions move their kanban card to `blocked` ("waiting for you") while the
agent is still actively working. The observable symptoms:

- A card flips to `blocked` mid-run even though opencode keeps producing output.
- A desktop/toast notification ("<title> is waiting for you") pops for a session
  that is plainly still working (`notifyBlockedTransitions`, `apps/web/src/main.ts:240`).

Both are the same bug surfacing twice — the notification is purely a function of a
card entering `blocked`, so any spurious `blocked` transition pops a spurious alert.

## Root cause

The generated opencode plugin (`apps/host/src/opencodePlugin.ts`) drives card state
off a single coarse edge:

- `session.created` / `session.updated` / `tool.execute.after` → `in-progress`
- `session.idle` (root session only) → `blocked`

This misreads "agent is working" as "agent is waiting on you" in two confirmed ways.

### 1. Retry stalls leave the host with no liveness signal

opencode's session status is a three-way enum, not a boolean:

```ts
type SessionStatus =
  | { type: "idle" }
  | { type: "retry"; attempt: number; message: string; next: number }
  | { type: "busy" }
```

`retry` is opencode's name for "not idle, just waiting to receive more tokens" — the
provider stream errored and opencode is backing off before resuming. The plugin does
not listen to `session.status` at all, so during a retry stall it posts nothing to the
host. The idle reconciler (`apps/host/src/idleReconciler.ts`) then sees a stale
`lastHookAt` (opencode writes no claude transcript, so the in-memory hook stamp is its
only liveness signal) and, after its window, sweeps the still-working card to `blocked`.

### 2. Child/subagent idle blocks the root on resume

Each opencode session — including subagents, title generation, and compaction, which
run as separate child sessions — emits its own `session.idle`. The plugin gates the
block on `rootId` so a child idle doesn't block the parent, but `rootId` is only learned
from `session.created` with no `parentID`. On resume (`opencode --session <id>`,
`apps/host/src/terminal.ts:492`) `session.created` never fires, so `rootId` stays empty,
the `!rootId` fallback fires, and any child idle blocks the card mid-work.

## Evidence (empirical, opencode 1.17.8)

Verified live against the installed opencode, not just the SDK types, using a
diagnostic plugin that logged every event reaching the plugin's `event` hook:

- A fake OpenAI-compatible endpoint returning HTTP 503 produced an alternating
  `busy → retry → busy → retry …` sequence into the plugin (6 `retry` events) and
  **zero** `session.idle`. So `session.status{retry}` is real, reaches plugins, and
  retry does **not** fire `session.idle`.
- A clean run produced `session.status{busy}` then `session.status{idle}`.
- With `bash: "ask"`, a genuine prompt produced `permission.asked` (carrying an `id`)
  then `permission.replied`. In every run where tools were auto-allowed, no permission
  events fired — so `permission.asked` is emitted only for real prompts and will not
  cause spurious blocks.

Note: the running 1.17.8 emits `permission.asked`; the cached SDK types (1.1.48) name it
`permission.updated`. The plugin should handle both names. The fine-grained
`session.next.*` streaming events are largely internal to opencode's TUI; `session.status`
and `permission.*` are the plugin-visible signals we rely on.

## Why claude is not affected (fix is opencode-only)

The claude path is structurally protected and needs no change:

- claude's harness handles API retries internally **without ending the turn** — it fires
  no `Stop` hook during a stall (`apps/host/src/hooks.ts:105`).
- claude liveness is the **durable transcript mtime** (written on every token,
  `apps/host/src/idleReconciler.ts:63`), so a stalled-but-working session shows a fresh
  mtime and is never swept; this also survives host restarts. opencode has only the
  in-memory `lastHookAt`.
- `PostToolUse` is a frequent recovery heartbeat keeping the card `in-progress`
  between tools (`apps/host/src/hooks.ts:29`).

## Design

Re-ground the opencode plugin's card-state mapping on `session.status`, the signal
opencode already computes, plus `permission.asked` for the genuine wait-on-user case.

### Plugin (`apps/host/src/opencodePlugin.ts`)

New event mapping:

- `session.status{busy}` → post `in-progress`
- `session.status{retry}` → post `in-progress` (still working — the core fix)
- `session.status{idle}` → post `blocked`, **root session only**
- `permission.asked` (alias `permission.updated`) → post `blocked`
- `permission.replied` → post `in-progress`
- `tool.execute.after` → keep as an `in-progress` liveness post
- `tool.execute.before` destructive-git guard → unchanged
- `session.idle` is no longer the block trigger (subsumed by `status{idle}`)

`busy`/`retry`/`permission.*` are not root-gated — any working session, or any genuine
prompt, is a correct signal regardless of which session emitted it. Only `idle→blocked`
is root-gated, so a child/subagent idle never blocks.

### Root-session gating + resume seed

`rootId` is seeded two ways:

1. `session.created` with no `parentID` (first launch, unchanged).
2. A new env var `ORDEN_OPENCODE_ROOT`, injected by the host in `buildCommand`'s resume
   path (`apps/host/src/terminal.ts`, where it already has `rec.conversationId` for
   `--session`). The plugin reads `let rootId = process.env.ORDEN_OPENCODE_ROOT || ""`
   at startup.

This closes the resume bug: on resume the root id is known up front, so child idles are
correctly ignored.

### Host (`apps/host/src/hooks.ts`)

Minimal change. `applyStateBySessionId` already stamps `noteHookActivity` on every post,
so the new `busy`/`retry` posts keep the reconciler's `lastHookAt` fresh — closing the
stale-sweep path. The `ALLOWED` set already permits `in-progress`/`blocked`, and the new
states route through the existing `/hooks/session-state` endpoint, so no host-side state
machine change is required.

### Downstream effect: notifications

No change to notification code. `notifyBlockedTransitions` (`apps/web/src/main.ts:240`)
fires the toast + OS notification solely when a card enters `blocked`. With actively-
working opencode cards no longer entering `blocked`, the spurious "waiting for you"
alerts stop. Genuine turn-end (root idle) and permission prompts still notify, which is
the intended behavior.

## Testing

- `apps/host/src/destructiveGit.test.ts` corpus: unchanged (guard logic untouched).
- New plugin-mapping test: replay the empirically-captured event sequences through the
  plugin's `event` handler and assert the posted states:
  - `busy → retry → busy → idle` → `in-progress, in-progress, in-progress, blocked`.
  - `permission.asked → permission.replied` → `blocked, in-progress`.
  - resume case: with `rootId` seeded (env), a child `session.idle`
    (`sessionID !== rootId`) does **not** post `blocked`; the root `idle` does.
- Manual verification: run an opencode session through a retry stall (fault-inject a
  provider 503) and confirm the card stays `in-progress` and no notification fires.

## Non-goals

- No changes to the claude hook path (structurally unaffected).
- No changes to notification UI, the idle reconciler windows, or `card_*` MCP tools.
- `question.*` events are not plugin-visible in this opencode version; a pure
  ask-the-user-a-question with no permission still relies on the root-idle fallback.
