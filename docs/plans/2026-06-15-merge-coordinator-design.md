# Merge Coordinator: autonomous cross-agent integration

Status: design (2026-06-15). Supersedes the never-merge stance of
`2026-06-10-session-worktree-isolation-design.md` for the single-user loop, and
extends the reactor model in `AGENTS.md` / `serve.ts`. Resumes the paused direction
captured in the `merge-coordinator-design` memory (session `0a9cd773`, 2026-06-14).

## Problem

Multiple agent sessions can be in flight against the same project at once. Each runs
isolated in its own worktree on an `orden/<slug>` branch (worktree isolation design).
At `card_complete` today the system knows **nothing** about other in-flight work:
`publishWorktree()` checks only *this* branch (clean → push → open PR). Ordering,
conflict resolution, and merge are entirely the user's manual job
(`merge-completed-card-worktrees` memory documents the recurring chore).

The user should never think about merge **ordering** or **mechanics**. The two human
touchpoints orden promises — approve the plan, review the evidence — must not silently
acquire a third: "reconcile these branches." But the user almost never reads code, so a
conflict resolution cannot be surfaced *as code* — that defeats the tool.

## What makes orden able to do this

A plain merge queue (Bors, GitHub merge queue, GitLab merge trains) knows only
*branches and test results*. Orden additionally holds **intent**: every session has a
`planDoc`, a card `title`/`description`, the journal block it spawned from, and proposed
learnings. So when two branches collide, the coordinator reasons over "branch A was
building X, branch B was building Y" — not just conflict markers. That intent context is
the entire reason this can be autonomous where a generic queue cannot.

## Locked decisions

1. **Continuous, host-side, autonomous auto-ordering.** No agent need be alive; the
   completing agent does nothing special — it just finishes and its worktree is clean.
2. **Merge-time awareness, not work-time.** Agents work blind to each other. The
   coordinator gains cross-branch + intent context only at integration, because merging
   requires a stationary target. (Live cross-agent awareness during work is explicitly
   out of scope.)
3. **Orchestrator–worker.** A dumb deterministic **reactor** owns the queue, ordering,
   `git merge-tree` pre-check, and the build/test gate — no LLM. It spawns **ephemeral
   resolver agents** only on a real conflict, handing each the intent context of **every
   contributing branch** — the incoming branch plus each already-integrated sibling whose
   hunks it collides with (one, or several) — then verifies and disposes.
4. **Escalation policy.** Silent on everything verifiable (clean merge OR
   resolved-and-green). Escalate ONLY two classes, at goal altitude, never as diffs:
   (a) **intent contradictions** — the goals themselves collide; and
   (b) **unverifiable resolutions** — no test covers it, or tests fail and the resolver
   can't fix them. Both escalate by moving the card to **`blocked`** with the question
   on the card — no new board column.
5. **Per-project merge boundary** (`Project.integrationMode`), mirroring the existing
   `Project.worktreeIsolation` override. The coordinator's *intelligence is identical*
   in both modes; only the terminal step differs.

## The two integration modes

`Project.integrationMode?: "fast" | "measured"` — absent = inherit the global default
in `vault/settings/app`.

- **`fast`** — fast-forward **local `main`** to the integration tip, rebuild dist.
  Silent on green. Dogfood loop (orden itself runs this). Pushing `origin/main` is a
  **separate, user-confirmed batched action** (the one irreversible outward step — never
  automatic; honors the confirm-outward-actions rule).
- **`measured`** — push the integration branch and open a **PR**; never touch local
  `main`. This is today's `publishWorktree()` push+PR flow, now gated behind a green
  *combined* test run instead of a single-branch one.

**Global default: `fast`** for now. (Future refinement, not built now: a remote-aware
default — no `origin` remote → `fast`; remote present → `measured`. Cheap to add via the
existing `no-remote` detection in `publishWorktree`, deferred per YAGNI.)

The terminal step is a one-line switch at the end of an otherwise-shared pipeline, so the
cross-agent ordering + conflict resolution — the actual value — runs identically either
way.

## Architecture

A fifth reactor, peer to the four already wired in `serve.ts` (launch-on-create,
reap-on-complete, publish-on-complete, journal-on-complete). It **supersedes**
publish-on-complete: `publishWorktree()`'s push+PR logic is reused verbatim as the
`measured`-mode terminal step inside the coordinator, so completion no longer pushes
eagerly — it enqueues for integration.

```
card → state:"complete" (clean tree, gate already passed by card_complete)
        │
        ▼  (host.onChange on `cards`)
  ┌─────────────────────────── mergeCoordinator (reactor) ───────────────────────────┐
  │ enqueue cardId into the integration queue (vault ns `merge-queue`)                │
  │ drain queue SERIALLY (single integration branch = single stationary target):     │
  │                                                                                   │
  │   ensure `orden/integration` exists off current main (ephemeral)                  │
  │   for each ready card, FIFO by completedAt:                                       │
  │     git merge-tree --write-tree integration <branch>                              │
  │       ├─ clean → apply merge onto integration                                     │
  │       └─ conflict → spawn EPHEMERAL RESOLVER AGENT                                 │
  │            (input: the incoming branch's planDoc/description/diff + the same for   │
  │             EACH already-integrated sibling owning a conflicting hunk [1..N] +     │
  │             the conflict hunks; task: reconcile so ALL their goals coexist)        │
  │              ├─ reconciled  → apply resolution onto integration                   │
  │              ├─ goals collide (cannot coexist) → ESCALATE intent → card:blocked   │
  │              └─ reconciled but unverifiable     → ESCALATE unverifiable → blocked │
  │     run the GATE on integration:  per-project verify cmd (default                 │
  │       `pnpm -r typecheck && pnpm -r test`) + `--filter @orden/web build`          │
  │       ├─ green → keep on integration, advance to next card                        │
  │       └─ red & resolver can't fix → ESCALATE unverifiable; RESET integration to   │
  │                prior tip; SKIP this card (stays blocked); continue the queue      │
  │                                                                                   │
  │   TERMINAL STEP (per integrationMode), once the queue drains:                     │
  │     fast     → fast-forward local main to integration tip; rebuild dist;          │
  │                mark N-commits-pending-push (manual, user-confirmed origin push)   │
  │     measured → push integration branch; open ONE PR; discard local integration   │
  └───────────────────────────────────────────────────────────────────────────────────┘
```

### Why a single serialized integration branch

The Not-Rocket-Science Rule (Bors) tests the *combined post-merge state*, serialized,
and advances trunk only if green. A single `orden/integration` branch IS that combined
state. Serial draining is mandatory — `merge-tree` and the gate both need a fixed tip.
Parallel integration is the documented Cursor failure mode (flat locks → throughput
collapse) and is explicitly rejected.

If card B depends on card A and A is skipped (escalated), B will likely fail its own
merge or gate and escalate too. That's acceptable: one bad branch does not stall the
waterfall; the rest drain, and the user resolves the blocked ones.

### Conflict classification is an OUTPUT, not a pre-step

There is no upfront "is this implementation or intent?" analysis. The resolver agent
*attempts* reconciliation given all contributing goals + diffs, and the outcome
classifies it:

- Reconciled + gate green → **implementation conflict**, merged silently.
- Resolver reports the goals cannot coexist → **intent contradiction**, escalate.
- Reconciled but gate red / no coverage and resolver can't fix → **unverifiable**, escalate.

This keeps the LLM invoked rarely (only on real textual conflict) and only where judgment
is actually required.

## Data model

New vault namespace **`merge-queue`** — one record per integration cycle attempt:

```ts
interface MergeQueueEntry {
  cardId: string;
  branch: string;            // orden/<slug>
  enqueuedAt: number;        // = card.completedAt, drives FIFO order
  status: "queued" | "merging" | "merged" | "skipped" | "escalated";
  result?: "clean" | "resolved" | "intent-conflict" | "unverifiable";
  integrationTip?: string;   // SHA of integration after this entry applied
  error?: string;
}
```

New fields on the **card** record (extends the existing publish-stamped set):

```ts
mergeStatus?: "queued" | "merging" | "merged" | "skipped" | "blocked-intent" | "blocked-unverifiable";
integrationBlock?: {        // present only when escalated; rendered on the blocked card
  kind: "intent" | "unverifiable";
  question: string;         // goal-level, no diffs: "A removes X, B and C depend on X — which goal wins?"
  options?: string[];       // one chip per contributing card (≥2 for intent); absent for unverifiable
  otherCardIds?: string[];  // every colliding sibling (1..N), not just one
};
mergedAt?: number;
```

New per-project field on **`Project`** (host-api):

```ts
integrationMode?: "fast" | "measured";   // absent = inherit global default
integrationVerify?: string;              // override gate cmd; absent = default pnpm -r typecheck && test
```

Global defaults live in `vault/settings/app` beside `prForge`/`isolation`/`baseRef`,
read through the existing `readWorktreeSettings`-style helper and wired in the web via the
`settingsBindings` seam (`bindSelect`).

## Escalation: how a blocked card resumes

When the coordinator escalates, it writes `integrationBlock` and sets the card to
`blocked` (card-state semantics: blocked = waiting-on-user). The card renders the
question at goal altitude with one option chip per contributing card (intent) or the
failing-gate summary (unverifiable) — no diffs.

The user's answer is the resume trigger. Mechanism (reactor on `cards`): when a blocked
card with an `integrationBlock` gains a `resolution` field (chip click writes
`integrationBlock.chosen`, or the user re-prompts a session), the coordinator re-enqueues
that card and re-drains. For an intent decision, choosing the winning card means: drop the
*other* contributing cards' conflicting changes from the integration (each loser's card
stays blocked with a note that its goal lost), keep the winner. For unverifiable, the user
either accepts (merge anyway, explicit) or sends the card back to its agent to add
coverage.

## Concurrency & safety

- **Single-flight.** The coordinator holds an in-process mutex; if several cards complete
  at once, they enqueue and drain one cycle at a time. Memoization Set per `serve.ts`
  reactor convention prevents double-processing a single write.
- **Clean-tree precondition stays.** `card_complete`'s existing dirty-refuse gate is
  unchanged — the coordinator only ever sees committed branches.
- **Reset on failure.** A red gate resets `orden/integration` to the prior good tip
  (`git reset --hard` is safe *here* — it's the host's own ephemeral integration branch,
  never a session worktree; the destructive-git guard targets agent shells, not host code).
- **Reaping unchanged.** `cardReaper` still removes a session's worktree once its branch
  is integrated (fast: merged to main; measured: pushed). Add `merged` to the set of
  reap-eligible publish/merge states.
- **origin/main push is never automatic** in `fast` mode — surfaced as a pending count,
  pushed only on explicit user action (outward-action rule, `run-orden-locally` /
  `integration-policy-merge-and-rebuild` memories).

## Testing

- `mergeCoordinator.test.ts` — inject `GitExec`; corpus of branch pairs:
  clean-merge, textual-conflict-reconcilable, intent-collision, unverifiable.
  Assert queue ordering (FIFO), serial draining, escalation writes, terminal-step switch
  by `integrationMode`, and integration-reset on red gate.
- Reuse the `GitExec`/`ForgeRunner` injection seam already established in
  `publishSession.ts` so the gate and forge calls are mockable.
- A resolver-agent stub (deterministic, returns canned reconcile/collide/unverifiable)
  so the coordinator pipeline is testable without spawning real agents.

## Out of scope (YAGNI)

- Work-time cross-agent awareness (decision 2).
- The original "final MCP call before merging" — an agent-driven tool can't see siblings
  and only fires if the agent is alive; the host reactor owns this instead. No new MCP
  tool ships. (A read-only `merge_status` survey tool could come later if a use appears.)
- Remote-aware default mode selection (deferred; global default is `fast`).
- Multi-target integration (release branches, stacked PRs) — single trunk only.

## Insertion points (grounded in current code)

- New reactor `apps/host/src/mergeCoordinator.ts`, registered in `serve.ts` after the
  journal reactor (~line 129), watching `cards`.
- New `apps/host/src/integrationBranch.ts` — `merge-tree` pre-check, apply, gate, reset
  (the only genuinely new git machinery; repo has none today). The integration branch is
  **materialized as a host-managed worktree** (`~/.orden/worktrees/<projectId>/_integration`):
  `merge-tree` is the cheap no-checkout *preview* (clean vs conflict + file list), but the
  actual apply, the resolver agent's edits, and the test gate all need a real checkout to
  run in. Reset = `git merge --abort` + `git reset --hard <prior tip>` in that worktree —
  safe host-owned territory, never a session worktree.
- Reuse `publishWorktree()` (`publishSession.ts`) as the `measured` terminal step.
- Extend `Project` (`host-api/src/index.ts:64`) with `integrationMode` / `integrationVerify`.
- Settings: `vault/settings/app` + `settingsBindings.ts` `bindSelect`; per-project
  override UI beside the existing worktree-isolation toggle (`projectModal.ts`).
- `cardReaper.ts`: add `merged` to reap-eligible states.
```
