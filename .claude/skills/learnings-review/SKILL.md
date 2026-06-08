---
name: learnings-review
description: Use when a card is completed and has pending learnings — distill the session's work into proposed README/ADR/AGENTS/skill edits and triage them.
---

# Learnings review

A learning is one proposed artifact change (README / ADR / AGENTS.md / a new skill),
carrying the FULL post-change file content, not a diff. No memories.

## Proposing (the completing agent)

Right before `card_complete`, call `learning_propose` once per proposed change. Skip it
when nothing was worth capturing.

## Triaging (the user, in the Learnings view)

One learning at a time, in a stepper:

- **Accept** — writes the file on the host (commits it when the dir is a repo).
- **Reject** — discards the proposal.
- **Comment** — a revise signal. The agent re-runs `learning_propose` with the learning's
  `id` and updated content, replacing it in place; it returns to `pending` for re-review.

A commented learning enters a `revising` state and the stepper advances to the next
pending one; the revised learning resurfaces when it lands. If the agent can't be reached,
the learning reverts to `pending` so the comment can be retried.
