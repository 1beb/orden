/**
 * The prose → WorkflowSpec compile contract. The compile is AGENT-DRIVEN: an
 * operator describes a process in prose, the agent (over the workflow_* MCP
 * capability) turns it into a typed runbook, validates it, and saves it. This
 * module is the pure data that guides that compile — the {@link WORKFLOW_SPEC_SCHEMA}
 * (what a compiled spec looks like) and {@link COMPILE_PROMPT} (the authoring
 * process + the closed primitive catalog). A future host-side LLM compile would
 * consume the same data.
 *
 * See docs/plans/2026-06-17-configurable-workflows-consolidated.md.
 */
import { ACTIONS, GATES, STAGE_ROLES } from "./catalog";

/** The four board lanes a step projects onto. */
export const BOARD_LANES = STAGE_ROLES;

/** The closed primitive catalog, as an authoring reference. */
export const PRIMITIVE_CATALOG = {
  actions: [...ACTIONS],
  gates: [...GATES],
  /** Lifecycle/publish actions — these project onto the terminal lane. */
  terminal: ["journal", "push", "open-pr", "merge", "reap", "propose-learnings"],
  /** Mid-work gating/parameterized actions — project onto the active lane. */
  active: ["run", "check", "capture", "code-review", "notify", "verify"],
} as const;

/**
 * The authoring prompt an agent follows to compile an operator's prose
 * description into a typed runbook. Carries the process + the closed catalog +
 * the validation trade-offs, so the first draft is sound. The agent then calls
 * workflow_validate to confirm before workflow_save.
 */
export const COMPILE_PROMPT = `# Compiling a workflow runbook

You are helping the operator turn a prose description of a process into a typed
workflow runbook — an ordered list of steps orden runs deterministically. The
operator describes WHAT should happen and in what order; you compile it to the
typed markdown format, validate it, and save it.

## The runbook format

A workflow is markdown: YAML frontmatter (name + description) then a numbered
list of typed steps. Each step is one of three kinds:

1. \`prose — <Label>\` — drive the agent with instructions (the non-deterministic
   part). The agent interprets the prose body. Indent the body under the step.
2. \`gate: <approve|review> — <Label>\` — a durable pause for the operator. The
   workflow parks until the operator approves/reviews; their decision is the
   resume signal. A gate can carry \`onReject\` routing (rework) via the spec,
   but the markdown form is just the gate type.
3. \`do: <action> — <Label>\` — a host effect (deterministic). The action is one
   of the closed catalog below.

Example:

\`\`\`markdown
---
name: my-workflow
description: What this workflow is for.
---

1. prose — Plan
   Write a short plan and park it.

2. gate: approve — Approve the plan
   I review the parked plan and approve before any code is written.

3. prose — Implement
   Work the plan on a branch and write up what changed.

4. do: check — Run the tests
   Gate on the test suite; failure loops back.

5. gate: review — Review the evidence
   I read and annotate the writeup.

6. do: journal — Journal
6. do: push — Push
6. do: reap — Reap
\`\`\`

## The closed primitive catalog (do: actions)

Lifecycle/publish (terminal lane):
- journal — log completion to the journal + card log
- push — push the session branch
- open-pr — open a PR via the configured forge
- merge — merge the branch (the merge coordinator owns integration)
- reap — kill the agent session + clean the worktree
- propose-learnings — the agent distills learnings before completion

Generic/parameterized (active lane):
- run — run a declared command (params.command); captures output, never gates
- check — run a command and gate on exit code (params.command); failure raises the card
- capture — capture command output / a file as evidence on the card log
- code-review — an agent reviews the diff
- notify — surface a note (params.message) on the card log
- verify — run an agent against a criterion; fail/uncertain raises the card

Gates (waiting lane):
- approve — pause for plan sign-off
- review — pause to review rendered evidence

## The compile process

1. Read the operator's prose. Identify the ordered steps, the gates between
   them, and which effects are host-run (do:) vs agent-run (prose).
2. Map each described step to the closest typed step. If prose can't map to a
   catalog action, keep it as a \`prose\` step (the agent does it) and note it.
3. Infer the board lane from the step: gates wait; terminal actions (push,
   open-pr, merge, reap, journal, propose-learnings) are terminal; mid-work
   actions and prose are active; the first prose step is initial.
4. Emit the markdown, then call workflow_validate. Address any errors. Surface
   warnings to the operator (e.g. no approval gate, merging unreviewed work).
5. On the operator's confirm, call workflow_save.

## Trade-offs to flag (warnings, not errors)

- No approval gate: the agent starts working with no plan sign-off.
- Merging with no review gate before the merge.
- Both isolation and the git guard off (destructive git in the real tree).
- Nothing publishes (work stays on the branch).
- A multi-model step with no aggregation.
`;
