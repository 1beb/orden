# ADR 0001: The learnings surface is agent-proposed, reviewed in place

Status: accepted
Date: 2026-06-08

## Context

When a session finishes work, we want it to surface proposed edits to durable
project docs (README / ADRs / AGENTS.md) or new skills, for the user to review and
accept. The open question was *who generates these proposals and how the user acts on
them*.

## Decision

- **Agent-proposed, not host-generated.** The completing agent calls the `learning_propose`
  MCP tool once per proposed change, carrying the FULL post-change file content (not a
  diff). The host does not run its own summarizer.
- **Render-only kanban column.** A `complete` card with open learnings buckets into a
  derived "Learnings" column; no card is ever stored in a `learnings` state (a web-local
  `BoardColumn` type keeps that a compile error).
- **Accept = the approval.** Accept writes the file on the host and commits it *only when
  the target dir is a git repo*; otherwise it writes straight to disk. orden must work in
  non-repo working dirs, so git is opportunistic, never required.
- **Comment = revise in place.** A comment is a signal for the agent to re-iterate that
  learning: it re-runs `learning_propose` with the learning's `id`, updating the record in
  place (status returns to `pending`) — never a duplicate. The learning enters a `revising`
  state so the stepper advances; it resurfaces when the revision lands.

## Consequences

- A completion driven purely from the web UI (not via the agent) currently produces no
  learnings, because nothing prompts the agent — see the follow-up to add a host trigger.
- The whole flow degrades cleanly without git and without a live agent (comments revert to
  `pending` when the agent can't be reached).
