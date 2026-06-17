# Configurable workflows — consolidated design (v2)

Date: 2026-06-17

Canonical spec for orden's configurable workflow system. Absorbs and supersedes the
model decisions in `2026-06-16-configurable-workflows-design.md`; keeps
`2026-06-17-workflow-primitives-and-prior-art.md` and
`2026-06-17-default-workflow-two-framings.md` as rationale/detail.

## What this is

Make "how orden works" configurable per task, not baked into one operator's habits.
An operator authors a workflow as a text runbook, with an agent's help; orden runs it
deterministically. The lifecycle, completion policy, in-session agent behavior, and the
standardized steps in between all become composable, configurable building blocks.

## Core decisions

- Authoring model is a runbook: an ordered list of typed steps, not stages-as-columns.
  The kanban board is a derived view of the active step.
- Effects are closed, composition is open. orden ships a closed, host-owned catalog of
  effect primitives (drift-guarded by a contract test); operators compose them plus
  prose into reusable blocks. No user-authored arbitrary-code primitives.
- The agent is the non-deterministic effect; the host evaluates all control flow. A step
  either drives the agent (prose, non-deterministic) or runs a host primitive
  (deterministic). Gates, branching, and transitions are decided by the host, never by
  the agent's own judgment.
- Authoring is agent-assisted through an MCP capability, with guidance delivered
  per-harness from one source (Claude skill + opencode wrapper).
- A repo holds many workflows; the session/card carries which one, chosen by
  agent-suggestion + operator confirm.
- Every field defaults to today's behavior; the built-in `default` workflow reproduces
  orden as it works now, so nothing changes until an operator opts in.

## The runbook model

A workflow is an ordered list of typed steps. Each step is one of:

- `prose` — drive the agent with instructions (non-deterministic effect). Carries agent
  settings: `harness`, `isolate`, `mode`, `git-guard`, `models` (array; >1 fans out),
  and `aggregate` (the reconciliation step for a multi-model fan-out).
- `primitive` — run a host effect from the catalog (deterministic), with parameters.
- `gate` — a durable pause for the operator (approve / review); see "Gates" below.

Steps run top to bottom. Two escape hatches keep it expressive without a graph:
conditional routing on a step's outcome (pass / fail / rework) and one rework loop back
to an earlier step. No free-form node canvas — that is the wrong altitude for an
operator and is reserved for engine internals if ever needed.

### Board projection

The kanban board is derived, not authored. Each step maps to a lifecycle role
(`initial` / `active` / `waiting` / `terminal`); the card shows the role of the active
step. Because every runbook projects onto the same four roles, a board can show cards
running different workflows without confusion. Authoring ("what runs, in what order,
with which gates") is decoupled from the view ("where is it now").

## The primitive catalog

The closed set of effects, each backed by a host executor and held in lockstep with the
catalog by a contract test. Current + planned:

- Lifecycle/publish: `journal`, `push`, `open-pr`, `merge`, `reap`, `propose-learnings`.
- Review: `review` (human gate), `code-review` (agent reviews the diff), `capture`
  (attach command output / coverage / screenshots as evidence).
- Generic, parameterized (the long-tail keystone): `run` / `check` — run a declared
  command, gate on exit code / output match, raise a card on failure. Covers tests,
  typecheck, lint, format, build, coverage, dependency/security audit by configuration.
- Communication/timing: `notify` (desktop / Slack / email), `wait` / `watch` (CI, a
  condition, an external event, a schedule).
- Gates: `approve`, `review`.

Adding a primitive is a contained change: one catalog entry + one host executor + the
contract test stays green. It is never an ad-hoc switch elsewhere.

## Extensibility: closed effects, open composition

- Effects (closed): the catalog above. The safety and determinism boundary. Inverting
  the typical plugin instinct on purpose — orden's effects are a fixed host tool list,
  not arbitrary code, which is what keeps a workflow reviewable at the level of intent.
- Composition (open): operators author named, parameterizable composites — reusable
  bundles of primitives + prose (functions/recipes). A composite is data, not code; it
  composes the closed set, it cannot introduce a new effect.
- Reuse is version-pinned / content-addressed. A shared workflow or composite is pinned
  at the point of reference (the tj-actions supply-chain lesson: mutable refs are a hole).

## Gates as durable suspensions

A gate parks the workflow with zero held resources, survives a host restart, and resumes
when the operator acts. orden already has the substrate: the vault change-feed is the
event source and annotation-delivery is the resume signal. A gate = "the workflow waits
on a vault key transition"; the resume payload carries the operator's decision (approve /
reject / annotations), and the next step branches on it. This unifies the annotation
feedback loop with workflow control — an annotation is the resume signal.

## Agent-assisted authoring

Two parts, deliberately separated so it works on every harness:

- Capability (harness-agnostic): an orden MCP tool family `workflow_*`
  (`list` / `propose` / `validate` / `save` / `render`). Both Claude and opencode reach
  orden's MCP, so authoring works identically on both — the same home as `card_*` and
  `learning_propose`.
- Guidance (one source, two wrappers): the brainstorming process the agent follows to
  help author a runbook, delivered as a Claude skill and an opencode equivalent (custom
  command / AGENTS guidance via the generated opencode plugin). Same pattern as the
  destructive-git patterns: authored once, embedded into both consumers.

Authoring flow: operator describes the process in prose with the agent's help; orden
compiles it to a `WorkflowSpec`, validates it, and shows the reading back once (mapping,
un-mappable prose flagged, trade-off warnings); the operator confirms. The confirmed spec
drives mechanics deterministically; the prose stays attached as the agent's per-step
instructions.

## Multiple workflows per repo

- Storage is a directory: `.orden/workflows/*.md` in the repo (travels with the code),
  plus the vault `workflows` namespace as a cross-repo library of reusable flows.
  Discovery lists both.
- The session/card carries the choice as a HOST_OWNED field (like `workdir` / `branch`).
  Resolution: `session.workflow ?? project.defaultWorkflow ?? DEFAULT_WORKFLOW`.
- Name collisions: a repo-local workflow shadows a vault one of the same name (more
  specific to the code).
- Selection: agent suggests from the task intent, operator confirms — never a silent
  pick (a workflow can auto-publish/merge). Each workflow's frontmatter carries a
  `description` / `whenToUse` the agent matches against and the picker shows.
- Symmetry: the operator confirms twice in a workflow's life — when it is authored
  (compile-confirm) and when it is bound to a task (selection-confirm). Both
  agent-proposed, human-decided.

## Modularity and extensibility seams

Built so each axis of change is a contained, additive edit — not a rewrite:

- `packages/workflows` (pure, no Node/fs) is the brain: the model, the catalog, the
  parser, the validator, the resolver. Host and web are the hands.
- Adding an effect: one catalog entry + one host executor; the contract test enforces
  the catalog<->executor bijection so the two can never silently drift.
- Adding a step kind: one member of the `Step` discriminated union + its renderer; the
  router/runner switches on `kind` in one place.
- Adding a harness: orden already abstracts harnesses; guidance is one source with a
  per-harness wrapper, capability is MCP (harness-agnostic).
- Composites and saved workflows are data (markdown + frontmatter), not code — operators
  extend the system without touching it.
- Control flow lives in one host-side router reacting to vault/hook events; never spread
  across per-view switches or delegated to the agent.

## Open questions / follow-ups

- Per-step agent override vs a single session spanning many steps (how a worktree/branch
  is shared or split across steps).
- Switching a card's workflow mid-run: re-map the active step or restart.
- Concrete on-disk runbook syntax (numbered list with typed prefixes vs frontmatter
  step table) — settle when building the authoring UI.
- Composite parameterization surface (typed inputs, like GitLab `spec:inputs`).
- Generating the `default` runbook from `DEFAULT_WORKFLOW` as the reference example.
