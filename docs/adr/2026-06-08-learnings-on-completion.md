# ADR-0015: Learnings on card completion — agents propose, users triage

**Date:** 2026-06-08
**Status:** accepted

## Context

When an agent completes a card, the session's work produced changes that should
persist beyond the session — updated READMEs, new ADRs, AGENTS.md refinements,
or reusable skills. Without a mechanism to capture these, institutional knowledge
stays siloed in session transcripts.

## Discussed in

Conversation `2f886c18-7abf-44b3-8412-ee916a622279` (2026-06-05 to 2026-06-08),
same session as ADR-0014:

> "I think this is the wrong framing. I want learnings to be generated when I
> say a card is complete. Then leave it in the learnings where I can accept,
> reject or comment on the learnings."

> "We make code changes we want to update readme/adrs/agents/create skills. I
> don't want to work with memories at all. I'd like learnings to have some UI
> that allows me to make quick decisions using the main window.
> Accept/Reject/Comment and automatically take me to the next learning."

The user initially requested a git-on-merge trigger: "I think we should do it
on merge to main or commit to main." This was **dropped** during design — orden
must work in non-repo working dirs, so learnings come only from the live
completing agent via `learning_propose`.

The UI went through 4+ mockup iterations with specific user feedback:
- "Don't show the explanatory text... Just show an x and a checkmark"
- "remove the red from the x... use the lighter purple we are using in the
  sessions ui"
- "why this doesn't need to be in a well. It also shouldn't be hidden on a
  mobile view"

The accept behavior was confirmed: "per-learning. one card at a time. staged
as a commit/pr if it's a repo otherwise straight to disk."

## Decision

**Right before `card_complete`, the agent calls `learning_propose` for each
proposed change. Learnings land in a review surface (the Learnings kanban column
+ learnings view) where the user accepts (writes the file + commits), rejects
(discards), or comments (sends back for revision).**

Learning model:
- `type`: `readme` | `adr` | `agents` | `skill`. No memories — only concrete
  file changes.
- `op`: `edit` (diff against existing file) or `create` (new file).
- Carries the FULL post-change file content (not a diff) so accept is a
  write-to-disk with no merge step.
- `status`: `pending` / `accepted` / `rejected`. Plus a comment thread.
- `targetPath`: project-relative file path.
- Stored in vault ns `learnings`, keyed by learning id.

Triage semantics:
- **Accept** writes the proposed content to `targetPath`. If the target is in a
  git repo, the file is staged and committed (`learning: <title>`). If not a
  repo, the file is written straight to disk with no commit.
- **Reject** discards the learning.
- **Comment** sends feedback back to the agent. The agent re-runs
  `learning_propose` with the SAME learning `id` and updated content, which
  updates the proposal in place (not a new learning). The revised learning
  returns to `pending` for re-review.
- A card leaves the Learnings column once every learning is triaged.

Trigger: `card_complete` is the trigger, not a gate — completion stays the
user's explicit call. There is no git-hook/merge-trigger custodian; orden must
work in non-repo working dirs.

**Rejected alternatives:**

- **Auto-write learnings on complete without review.** Would allow agents to
  modify README/AGENTS/ADRs without human oversight — defeats the review-loop
  premise.
- **Memories (free-form unstructured notes).** The user rejected this: memories
  drift, duplicate, and rot. Only concrete file changes (README/ADR/AGENTS/skill)
  are captured.
- **Git post-commit/merge hook for AGENTS.md drift.** Ordered must work in
  non-repo dirs; a git-trigger can't be the mechanism. Learnings come only from
  the live completing agent via `learning_propose`.

## Consequences

**Easier:**

- Project documentation (README, ADRs, AGENTS.md) stays current automatically
  as agents complete work, with human review as the gate.
- The learnings view is a focused, one-at-a-time stepper — not an overwhelming
  batch review.
- Comments create a revise loop: the agent refines the proposal in place, no
  duplicate learnings.

**Harder:**

- Agents must be prompted to call `learning_propose` before `card_complete`.
  Forgetting this step means learnings are lost from that session.
- The accept commit behavior is opportunistic (only in git repos). A non-repo
  working dir gets file writes without version control.
- The agent re-proposing with the same learning `id` for revision requires the
  agent to carry the id across turns — a stateless agent may lose it.
