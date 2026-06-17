# Workflow primitives, extensibility, and prior art

Date: 2026-06-17

Companion to `2026-06-16-configurable-workflows-design.md`. Records the building-block
primitive set programmers need, the extensibility model, and what a survey of CI,
workflow-orchestration/runbook, and agent-orchestration systems teaches us.

## Extensibility model: closed effects, open composition

The decision: orden keeps a closed, curated set of effect primitives (the catalog,
each backed by a host executor and held in lockstep by the contract test), and makes
composition open — operators assemble those primitives plus prose into reusable blocks.
Extensibility lives in composition and parameterization, not in the ability to add new
effects.

Three layers:

- Effects (closed): the things that touch the world — git (push/open-pr/merge), run a
  command, notify, wait, capture, render, open-in-panel, move-card, create-session,
  deliver-annotation, agentic verify. A fixed host-owned set. This is the safety and
  determinism boundary.
- Generic effects (closed, but parameterized): a small number of primitives whose
  configuration covers a long tail. The keystone is `run`/`check` — execute a declared
  command, gate on exit code / output match, raise a card on failure. One primitive
  covers tests, typecheck, lint, format, build, coverage, benchmarks, dependency audit.
- Composition (open): operators author named, parameterizable blocks that compose
  existing primitives plus prose (functions/recipes). Sharing/reuse is version-pinned.

This inverts the typical plugin instinct on purpose. orden's effects are a fixed host
tool list, not arbitrary code, so the safe move is to keep effects closed and let
operators compose freely — which is also what keeps a workflow reviewable at the level
of intent (orden's whole thesis) rather than forcing a code read.

## The primitive catalog programmers need

Beyond today's lifecycle/gates/publish set, the building blocks a developer workflow
wants, mapped to primitives. New ones are tagged.

Run and gate:

- `run` / `check` (new, keystone): run a declared command; gate on exit code / output
  match; fail/uncertain raises a card. Covers tests, typecheck, lint, format, build,
  coverage, benchmarks, dependency/security audit — all by parameterization.

Review and evidence:

- `review` (gate, exists): human reviews rendered evidence before advancing.
- `code-review` (new): an agent reviews the diff (distinct from the human gate).
- `capture` (new): capture command output / coverage / screenshots as an artifact and
  attach it to the card or doc, feeding the review-by-evidence loop.

Communication and timing:

- `notify` (new; orden half-does this on `blocked`): ping a channel (desktop / Slack /
  email) on a transition, on blocked, or to request review.
- `wait` / `watch` (new): wait for CI, for a condition, for an external event/webhook,
  or on a schedule. Ties into the existing schedule/loop features.

Version control and release:

- `push`, `open-pr`, `merge` (exist / catalogued): branch publishing.
- Tag a release, write a changelog, bump a version: compositions over `run` + git.

Integration and environment (later, mostly compositions):

- Issue/ticket sync, deploy/rollback, run a notebook, web research: compositions over
  `run` + `notify` + an `http`/MCP-backed primitive, or distinct primitives if a real
  need appears.

Agent orchestration:

- Per-stage `models` array + `aggregate` step (already in the model): parallel-model
  fan-out reconciled by an explicit aggregation.
- Subagents: via stage prose (the agent spawns its own). Workflow-level session fan-out
  is deferred.

## Prior art

A survey of three families. Full notes archived in the research; the load-bearing
findings:

### CI/CD pipelines (GitHub Actions, GitLab CI, CircleCI, Jenkins)

- The winning pattern is a closed set of element types with open composition, not open
  plugins. CircleCI orbs are the cleanest: the vocabulary is exactly commands / jobs /
  executors / parameters — four words — yet each wraps arbitrary work. GitHub fixes the
  reuse kinds (composite action, reusable workflow); GitLab is converging on typed,
  versioned Components.
- Jenkins is the cautionary tale of fully-open extension: steps-are-plugins plus
  arbitrary Groovy bought a decade of sandbox-bypass RCEs and a manual-approval
  bottleneck. No fixed vocabulary means you cannot statically audit or cleanly sandbox.
- Higher-order composition can be a typed primitive, not an escape hatch: CircleCI's
  `steps` parameter type lets a command accept a sequence of steps as a value — bounded
  extensibility without opening the type system.
- Version-pinning/immutability is the determinism mechanism. The tj-actions supply-chain
  attack (CVE-2025-30066) breached every tag-pinned consumer the instant a tag moved;
  SHA-pinned ones were untouched. Shared workflow units must be version-pinned or
  content-addressed, ideally immutable once published.
- Human approval is a first-class typed gate everywhere (CircleCI `type: approval` job
  that runs zero steps and just waits; Actions environment reviewers; GitLab
  `when: manual`; Jenkins `input`).

### Workflow engines and runbooks (Temporal, Airflow, n8n, Windmill, Dagger, Rundeck, Ansible)

- Every mature system is open at the effect layer (write a module/activity/node/script)
  and closed at the orchestration layer (a fixed DAG/flow/playbook grammar). The split
  that matters is enforced by power: Temporal with a hard determinism contract;
  Airflow/Ansible by idempotent/side-effect-free convention.
- Temporal's workflow-vs-activity split maps onto orden — but inverted in nature. The
  non-deterministic layer is the agent/prose (an LLM run is the least reproducible thing
  there is — orden's "activity"); the deterministic layer is the host primitives (a push
  is a push). The rule to adopt: control flow (gates, branching, transitions) lives in
  the deterministic host layer; the agent is the effectful work inside a step, never the
  decider of the workflow's branching. orden already does this — hooks drive card
  transitions, not the agent's MCP calls.
- The runbook shape (ordered steps with human gates between them) fits orden's two
  touchpoints — approve the plan, review the evidence — better than a kanban state
  machine. See the open question below.
- Gates should be durable suspensions, not busy-waits: Temporal signals, Windmill/Mastra
  suspend-and-resume, LangGraph `interrupt`. orden already has the substrate — the vault
  change-feed is the event source and annotation-delivery is the resume signal. A gate =
  "workflow waits on a vault key transition."
- Make a `prose` (agent) step idempotent by making the durable thing the host-recorded
  result (the parked doc, the branch, the card state), not the agent run — generalizing
  orden's existing self-heal/idle-reconciler philosophy.

### Agent orchestration (LangGraph, CrewAI, AutoGen, Semantic Kernel, AgentKit/Mastra/Prefect/Dagster)

- Linear backbone is the right default for operator authoring, with two escape hatches:
  conditional routing on a step's outcome (pass/fail/rework) and one loop construct
  (rework back to a prior step). Pure-linear hits a wall (CrewAI sequential has no
  branching); a free-form graph canvas is the wrong altitude for an operator. Reserve
  arbitrary cyclic graphs for engine internals, not the authoring surface.
- Parallel-model fan-out is an explicit map/reduce stage (LangGraph `Send`, Mastra
  `.parallel()`+`.map()`), not emergent group chat. orden's per-worktree isolation is a
  natural fit: run N models/harnesses in parallel worktrees, feed candidates to one
  aggregator stage. Avoid AutoGen-style emergent reconciliation (nondeterministic,
  unreviewable).
- Human review is a first-class stage that durably suspends and resumes with the
  operator's decision as the payload — and in orden an annotation is the resume signal,
  unifying the feedback loop with workflow control.
- MCP is the open capability seam already; keep stage/effect types few and curated. Open
  at the tool layer, curated at the authoring layer.
- Routing (which step next) is a deterministic code function over state, distinct from
  the agents doing the work; LLM routing is opt-in. orden's hook-driven transitions are
  already this.

## What this changes in our design

Confirmed:

- Closed effect set + open composition (we already built the closed catalog + contract
  test + resolver — the right substrate).
- Linear model with explicit fan-out→aggregate; no free-form graph canvas.
- The generic `run`/`check` primitive as the keystone of the programmer-needs set.
- Gates as durable vault suspensions; annotation as resume signal.

Refined or added:

- Make the determinism rule explicit: control flow is host-evaluated; the agent is the
  effect inside a step, never the router. (We have the instinct; name it.)
- Add the two escape hatches to the linear model: conditional routing on a step outcome
  and one rework loop — covering plan → implement → review → rework → done without a
  graph.
- Version-pin / content-address any shared or reusable workflow unit.

## Open question: runbook authoring vs kanban authoring

The strongest cross-family signal: operators want to author an ordered runbook of typed
steps (`prose` | `primitive` | `gate`) with gates between them, and watch the lifecycle
on the board. Our current model conflates the two — headings are stages and stages are
board columns. The research suggests decoupling them: author a runbook; project it onto
the kanban as the lifecycle view of the active step (the design doc already treats the
card as a session's projection). This is a real fork to settle before Stage 3, because
it changes the authoring surface, though not the closed-effects substrate already built.
