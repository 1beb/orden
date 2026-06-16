# Configurable workflows design

Date: 2026-06-16

## Problem

Orden's behavior is shaped by one operator's personal workflow, and most of that
shaping is hard-coded rather than configurable. The cosmetic preferences (fonts,
accent, completed-task fade) are already settings; the deep coupling is in the
lifecycle and its side-effects:

- The four board stages (`planning -> in-progress -> blocked -> complete`) and their
  fixed meanings.
- What fires on a transition: launch-on-create, journal-on-complete,
  publish-on-complete (push + PR, never merge), reap-on-complete.
- The completion gates: approve-a-plan, review-evidence-as-learnings, with learnings
  limited to README/ADR/AGENTS/skill.
- Branch naming (`orden/<slug>`), the never-merge policy, the destructive-git denial.

Other operators want to set up their own processes. A code project wants
`plan -> work -> PR`; a writing project wants `draft -> review -> publish` with no git;
a throwaway exploration wants `just run` with no ceremony. Today all three are forced
through one pipeline.

## Goal

Make "how the application works" configurable per project through a simple, text-first
workflow definition, without exposing workflow plumbing as a heavyweight builder UI
(orden's principle: silence about mechanics is a feature). Every workflow field
defaults to today's behavior; a project overrides only what it needs differently.

## Decisions

These were settled during brainstorming and frame the design.

- Scope: workflows govern lifecycle, completion policy, and in-session agent behavior,
  per project. Every field defaults to today's behavior; empty override = inherit.
- Authoring: text. A workflow is a markdown file the operator writes as a description.
- Interpretation: a fixed catalog of primitives drives deterministic host mechanics;
  the prose drives the agent's instructions. The host never guesses an irreversible
  action fresh per run.
- Structure: markdown headings are the stages (board columns, in heading order); prose
  under each heading is the description.
- Location: reusable workflows live in the vault; a project repo can override with its
  own workflow file so it travels with the code.
- Module: a dedicated, pure `packages/workflows` owns the model, catalog, parser, and
  validator. Host and web consume it.

## The workflow file

Headings are stages; prose under each is plain description. No markup tokens.

```markdown
---
name: Code (PR)
---

## Planning

Write a short plan and let me approve it before you start coding.

## In-progress

Work on your own branch. Commit as you go.

## Review

Write me a readable summary of what changed, not a diff dump.

## Complete

Push the branch and open a PR.
```

On save, orden compiles this into a `WorkflowSpec`: stages
`Planning -> In-progress -> Review -> Complete`; an approval gate after Planning; a
review gate at Review; on entering Complete, push + open-PR (plus journal/reap inherited
from the default unless the prose overrides). The prose under each heading stays
attached as the agent's instructions for that stage.

### Compile, validate, confirm

Authoring is just description; a one-time confirm step is where prose becomes a
deterministic spec safely.

- Renaming is free. Stage names are the headings; gate and action labels can be renamed
  too. Orden maps the operator's label onto the underlying role/primitive and remembers
  the mapping; it acts on the primitive, the operator sees their own words everywhere.
- The confirm step does three jobs: reads back the mapping ("I read 'Ship it' as your
  terminal stage; on entering it I'll push and open a PR"); flags prose that maps to
  nothing in the catalog ("I can't do this part automatically") instead of dropping it
  silently; and warns on trade-offs (see below). The operator can accept anyway; these
  are warnings, not walls. Nothing irreversible is wired up until this screen is seen.

Trade-off warnings, by example:

- `push+merge` with no review gate: "this merges work you haven't reviewed."
- isolate off and git-guard off: "the agent can run destructive git in your real working
  tree."
- no approve gate: "the agent starts working immediately, no plan sign-off."
- terminal stage with no completion output: "work stays on the branch; nothing publishes
  it."

## The primitive catalog

The closed set of things orden knows how to run. Prose maps onto these at compile time.
The set is deliberately closed: prose asking for something outside it is flagged at the
confirm step rather than silently ignored. Each item is something hard-coded today, now
made selectable. Adding a primitive is a contained code change, not a rework.

Stages (operator-named, each carries a role so the auto-cycle still works):

- `initial` (card lands here), `active` (hooks move here when the agent works),
  `waiting` (hooks move here at turn-end / when blocked on the user), `terminal`
  (user-only; fires completion). Headings supply names and order; orden infers the role
  and shows its guess at confirm.

Gates (points that pause for the operator):

- `approve` (agent parks a plan and waits for an OK), `review` (agent renders a writeup
  to read/annotate before the stage advances).

Transition actions (fire on entering/leaving a stage):

- `journal`, `push`, `open-pr`, `merge`, `reap` (kill session + clean worktree),
  `propose-learnings`, `verify` (see below). `merge` is new: today the policy is
  never-merge; as a primitive it becomes an opt-in per workflow.

Agent settings (in-session behavior for the workflow or a stage):

- `harness` (claude/opencode), `isolate` (worktree on/off), `mode` (tui/gui), `git-guard`
  (destructive-git denial on/off; only bites in a shared checkout).

Completion output (what "done" produces):

- `none` / `push` / `push+pr` / `push+merge`, and which learning kinds are in play
  (readme/adr/agents/skill, extensible).
- How to handle an uncommitted tree at a publishing step is workflow-expressible
  ("commit everything and push", "push only what's committed", "ask me"). When the prose
  does not say, or the situation is ambiguous, the safe fallback fires: park in the
  waiting stage with the reason (see "Dirty state" below).

## The checkmark is the completion criteria

Clicking complete in the session UI means one thing: advance the card to its workflow's
terminal stage. Driven by the spec, that action:

- checks upstream gates; if `approve` or `review` is unsatisfied it warns or blocks (the
  workflow's choice) rather than silently completing;
- runs the terminal stage's on-enter actions deterministically: whatever the workflow
  declared (`push` / `open-pr` / `merge` / `none`), plus `journal`, `propose-learnings`,
  `reap`.

So "what completion does" stops being hard-wired (today: always push + PR, never merge,
always journal/reap) and becomes exactly what the workflow's terminal stage says. The
checkmark is the same action whether a human clicks it or the agent calls
`card_complete`: one path, governed by the spec.

## Dirty state parks the card in "blocked"

Cross-cutting rule: whenever orden tries to advance a stage but cannot cleanly run that
stage's declared actions, it moves the card to the waiting-role stage (what the default
calls "blocked") with a plain-language reason attached. It never proceeds silently and
never throws an error the operator will not see. The board is the notification: a card
in the waiting stage with a reason means orden needs the operator.

"Dirty" is metaphorical: any unmet precondition, not only git. Cases:

- Uncommitted changes when a stage wants to publish, and the workflow does not say how to
  handle them (or the situation is ambiguous). Today `card_complete` simply refuses;
  instead the card parks in waiting: "uncommitted changes; commit or discard, then
  complete again."
- A blocking `verify` failed (see below); the raised card is linked.
- A required gate unsatisfied: "plan not approved yet."

This sharpens what the waiting stage means across orden. Two ways in: the agent
voluntarily ends its turn (today's meaning), and orden tried to advance and was stopped
by a dirty state (this). Both say "your move."

## Drift prevention and `verify`

Two layers; the hard invariant is deterministic, not agentic.

The deterministic backbone: the catalog is the single source of truth, and every
primitive must register an executor in the host. A contract test asserts the bijection
both ways: every catalog primitive resolves to a real host executor, and every host
executor is declared in the catalog. The `WorkflowSpec` schema and the validator's
trade-off rules may only reference primitives that exist. This runs in `pnpm -r test`,
so the build breaks the moment `packages/workflows` and the host/web drift apart. It is
fast and cannot hallucinate.

The agentic layer, which is also a catalog primitive: `verify` runs an agent against a
plain-language criterion and reports pass / fail / uncertain. Because it is a primitive,
it composes into any workflow ("verify the writeup reflects the diff before Review
advances"). Orden dogfoods it: orden's own dev workflow runs a `verify` step that reads
the catalog against the host/web implementations and reports semantic drift the bijection
test cannot see. The agentic layer sits on top of the contract test, never instead of it.

### Verify outcomes raise cards

- Pass: silent. The transition proceeds, no card.
- Fail / uncertain: raise a card via the existing `card_create` path, in the initial
  stage, linked to the originating session, titled with the criterion, body carrying what
  was checked, the verdict, and why it flagged. Every failed or unsure check becomes a
  trackable work item instead of a log line.

Whether a fail/uncertain also holds the originating stage depends on position:

- `verify` at a gate position holds the stage: the origin card moves to waiting, the new
  card is the thing to act on, and nothing irreversible runs until it is resolved.
- `verify` as a plain transition action raises the card but lets the workflow continue
  (advisory).

Default (overridable in the workflow prose): fail blocks, uncertain raises-but-continues.

## Module boundary

`packages/workflows` (pure, no Node/fs/process; importable by host, both Host
implementations, and web) owns:

- the `WorkflowSpec` type (stages + roles, gates, actions, agent settings, label
  <-> primitive mapping);
- the primitive catalog (the single source of truth);
- the markdown parser (headings -> stages) and the validator (the trade-off rules);
- the compile spec (the instructions for turning prose into a `WorkflowSpec`).

Outside the module: the host runs the actual LLM compile call and owns execution. The
existing reactors in `serve.ts` stop being hard-coded and instead read the resolved
`WorkflowSpec`. Web owns the confirm/validate screen, the read-only pipeline diagram, and
the per-project picker. Same seam style as keybindings and the view registry: extend the
catalog, do not add switches.

## Resolution and inheritance

- A built-in `default` workflow reproduces today's behavior exactly, so existing projects
  are unchanged until an operator opts in.
- Reusable workflows live in the vault (for example `vault/workflows/*.md`), consistent
  with orden keeping its generated structure in the vault.
- A project overrides by dropping a workflow file in its own repo (for example
  `.orden/workflow.md`), so it travels with the code and other operators of that repo
  inherit it.
- `extends` lets a workflow inherit another and override only the differences; a minimal
  workflow can be a few lines.

## Open questions / follow-ups

- Exact on-disk path for the project-repo override (`.orden/workflow.md` vs other).
- Whether stage roles can be many-to-one (e.g. two `waiting`-role stages) or must be
  unique.
- How a per-stage agent override interacts with a running session that spans stages.
- Migration: generating the `default` workflow file from the current hard-coded behavior
  as the reference example.
