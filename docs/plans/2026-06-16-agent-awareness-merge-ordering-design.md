# Agent awareness and ordering via MCP — design

Date: 2026-06-16

How sibling agents working the same repo get their work integrated without the
user managing merge mechanics. This is the "agent awareness and ordering"
feature. It builds directly on the merge coordinator already implemented on
branch `orden/agent-awareness-and-ordering-via-mcp-2` (8 commits, green, not yet
merged; design+plan in `docs/plans/2026-06-15-merge-coordinator-{design,plan}.md`).

## Problem

Multiple sessions run in isolated worktrees, blind to each other. At completion
each one's branch must land on trunk. Today `publishWorktree()` checks only its
own branch — it knows nothing about other in-flight branches, so two sessions
that each look fine alone can break trunk when combined (merge skew), and the
user is left doing the ordering by hand (the manual process captured in the
"merge-completed-card-worktrees" routine).

The user reviews intent and rendered results, never code diffs. So the entire
integration layer must be something they almost never see.

## What the research settled

External survey of 2024–2026 multi-agent code orchestration confirmed four
dominant patterns and where each fits:

- Worktree/sandbox isolation + PR integration — the universal coding-agent
  baseline (Claude Code, Cursor, Codex, Devin, Factory). Orden already does this.
- Serialized merge queue testing the combined post-merge state (Bors / the "Not
  Rocket Science Rule" / GitHub merge queue / GitLab merge trains) — the answer
  to "green alone, broken together."
- Orchestrator-worker fan-out/fan-in (Anthropic research system, MultiDevin) —
  fast for decomposable read-heavy work, risky for concurrent writes.
- Speculative/structural conflict pre-checking (`git merge-tree --write-tree`,
  stacked PRs, semantic-merge research).

The loud warning (Cognition, "Don't Build Multi-Agents"; MAST study): agents that
act on partial views of each other make conflicting implicit decisions. The fix
the industry converged on is to keep agents isolated and reconcile at integration
time with full context. Intent-aware reconciliation is still academic everywhere
except orden — because each orden session already carries a plan doc, orden holds
the intent that semantic-merge tools must reverse-engineer from diffs. That is the
differentiator.

## Decisions

Architecture: orchestrator-worker, host-owned. A deterministic reactor (no LLM)
owns the queue, ordering, the `git merge-tree` pre-check, and the verify gate. It
spawns an ephemeral resolver agent only on an actual conflict, then disposes it.
Same pattern as orden's other reactors (launch-on-create, reap-on-complete).

Merge-time awareness, not work-time. Agents stay isolated and blind to each
other; coordination happens only when state is stationary. No agent ever acts on
a partial view of a sibling. This is the Cognition lesson encoded structurally,
and it is host-driven, so it survives the MCP-drop failure mode (no dependency on
the original session's MCP transport staying alive).

Topology: linear queue, auto-stack on detected dependency. Default is a linear
merge queue onto trunk, each branch tested against the speculated combined state.
A stacked "waterfall" ordering is produced only when the reactor detects a real
dependency (intent references plus edits sitting atop a sibling's additions) —
never user-declared, never forced on independent work.

Conflict handling: intent-aware resolver agent, escalate only on contradiction.
On an independent-overlap conflict the reactor spawns a resolver agent given both
branches' plan docs and the conflicting hunks; it reconciles, the host gates the
result, and the user is involved only on genuine intent contradiction or an
unverifiable result.

No awareness view. The cross-agent context (order, predictions, overlapping
files, intent) is internal data the reactor and resolver consume, never rendered.
Nobody wants to watch an integration queue. The only thing that ever reaches the
user is the rare escalation, surfaced as a goal-level decision on the blocked card
via the existing decision chips.

## The drain loop

The reactor is single-flight per project — one drain at a time, so trunk only
advances against a known state. Per branch, in FIFO order:

1. Pre-check with `git merge-tree --write-tree` against current trunk (in-memory,
   zero side effects). Clean goes straight to the gate.
2. On a textual conflict, classify before resolving, using each side's intent
   (plan docs / card descriptions) plus the overlapping diffs:
   - Dependency (B's plan references A's feature; edits sit atop A's additions) —
     auto-stack: rebase B onto the integrated A, re-run `merge-tree`. This is the
     only place a waterfall is produced.
   - Independent overlap (two unrelated changes hit the same lines) — hand to the
     resolver agent.
   - Intent contradiction (A deletes the abstraction B depends on) — escalate,
     do not resolve.
3. Resolver or stack produces a candidate merged tree.
4. Gate: run the per-project verify command on the combined state. Empty verify
   means textual `merge-tree` only, no semantic gate.
5. Green — apply: fast-forward merge to trunk, run the rebuild command, advance.
   Red and unfixable — reset trunk to the pre-apply state, escalate as
   unverifiable.

The gate tests the combined post-merge state, so "each session looked fine alone"
cannot break trunk.

## The resolver agent

Spawned only on an independent-overlap conflict. Ephemeral — created, used,
disposed. Not a session card; no board presence, no lifecycle state.

Inputs: both branches' plan docs plus card title/description (what each side was
building), the conflicting hunks only (not the whole diff), and the merge base.

Job, narrowly scoped: produce a merged version of the conflicted regions that
honors both intents. It may not redesign, refactor, or touch anything outside the
conflict. It writes the resolution to the integration branch.

The host, not the agent, verifies. The resolver's output is never trusted on its
word; it goes through the same gate. Trust stays anchored on the test suite, not
on an LLM's say-so.

Escalation criteria (agent reports, host decides): the intents genuinely
contradict, or the result will not verify and the agent cannot fix it within the
conflict scope.

The host spawns and drives this, so it is robust to MCP drops — a fresh isolated
process, independent of the original session's transport.

## Data model

Both namespaces already exist on `-mcp-2`:

- `merge-queue` (per project) — ordered entries, each
  `{sessionId, cardId, branch, planDocRef, state}`, state one of
  `queued | predicted-clean | stacked-on:<sessionId> | resolving | escalated | integrated`.
  Internal context store; never rendered.
- `merge-status` (per project) — drain status: current single-flight target, last
  result, pending-push count.

## Trust model

- Silent on everything verifiable: clean merge, auto-stack-then-green, or
  resolver-then-green all integrate and rebuild with no user involvement.
- Escalate only two cases, at goal level, on the blocked card: intent
  contradiction and unverifiable resolution.
- Trust rests on the per-project verify command. Empty verify is explicitly no
  semantic gate.
- The reactor never merges to the default branch on a conflict it could not
  verify; it resets trunk and escalates.

## Implementation path

1. Forward-port `-mcp-2` — bring its 8 commits onto this branch; confirm the
   workspace is green (host + web suites). No new behavior, engine present.
2. Auto-stack on detected dependency — extend the drain's conflict classifier to
   distinguish dependency vs independent-overlap vs contradiction; add the
   rebase-onto-integrated path. Test against a corpus of synthetic two-branch
   scenarios.
3. Intent-aware resolver agent — replace `conservativeResolver`'s
   escalate-everything with the ephemeral agent; host-driven spawn, gate its
   output, dispose. Keep conservative as the fallback when no plan doc exists.

Each phase ships independently and leaves the loop working; the conservative
escalation is the safety net behind every later phase.
