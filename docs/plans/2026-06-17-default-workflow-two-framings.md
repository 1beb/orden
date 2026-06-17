# The existing default workflow, written two ways

Date: 2026-06-17

A concrete artifact to compare the two authoring models for the same behavior: orden's
current hard-coded default (plan, approve, work isolated, review evidence, on complete
journal + push + open-PR + reap + propose-learnings, never merge, dirty tree parks the
card). Same behavior both times — only the authoring shape differs.

## Framing A: stages = columns (current model)

Headings are the stages, and the stages are the board columns. Gates and transition
actions are described in the prose under each heading.

```markdown
---
name: default
---

## Planning

Write a short plan as a doc and park it for me. Wait for my approval before you write
any code.

## In-progress

Work the plan on your own branch in an isolated worktree. Commit as you go.

## Blocked

You are waiting on me: a question, or you have finished your turn. If the working tree
is dirty when you try to complete, or a gate is not satisfied, you land here with the
reason.

## Complete

Render a readable writeup of what changed for me to review first. On completion: log to
the journal, push the branch, open a PR (never merge), clean up the worktree, and
propose learnings.
```

What is awkward here: the approval gate is buried in Planning prose; the review gate and
all five completion actions are crammed into the Complete heading; and "Blocked" is a
state, not a step you author — it is really a place the lifecycle falls into. The four
columns are doing double duty as both the authoring unit and the board view.

## Framing B: runbook of typed steps, kanban as a projection

An ordered list of typed steps. Each step is `prose` (drive the agent), `primitive` (a
host effect), or `gate` (a durable pause for the operator). Gates sit between work steps.

```markdown
---
name: default
---

1. prose — Plan
   Write a short plan as a doc and park it.

2. gate: approve — Approve the plan
   I review the parked plan and approve before any code is written.

3. prose — Implement (isolated)
   Work the plan on your own branch in an isolated worktree. Commit as you go.

4. primitive: render — Render the evidence
   Render a readable writeup of what changed.

5. gate: review — Review the evidence
   I read and annotate the writeup; my annotations flow back to you.

6. primitive — Publish (on my approval), in order:
   - journal the completion
   - push the branch
   - open a PR  (never merge)
   - reap the session and clean the worktree
   - propose learnings
```

Dirty-tree / unmet-gate handling is not a step you author; it is a global rule: any step
that cannot cleanly run parks the card with a reason. That removes the awkward "Blocked"
heading from Framing A.

### The kanban projection of Framing B

The board is not gone — it is derived from which step is active:

- steps 1-2 active  ->  Planning column
- steps 3-4 active  ->  In-progress column
- any gate waiting, or a parked dirty/unmet-precondition  ->  Blocked column
- step 6 done  ->  Complete column

So the operator authors an ordered runbook and still watches it as a four-column board.
Authoring ("what runs, in what order, with which gates") is decoupled from the view
("where is it right now").

## The tradeoff in one line

Framing A is one mental model (columns) and is already half-built, but it smears an
ordered sequence across four fixed columns and hides gates/actions in prose. Framing B
reads like the runbook/CI shape every surveyed system converged on, makes gates and
effects first-class and legible, and keeps kanban as a derived view — at the cost of a
new authoring surface in Stage 3. Neither changes the closed-effects substrate already
built (catalog + executor registry + resolver).
