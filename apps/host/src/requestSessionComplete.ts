// Hand a UI-initiated completion to the session's own agent. Clicking the
// checkmark in the sessions UI is the user's explicit say-so to complete — but
// completing the card directly from the web skips the learnings flow (and the
// reap-on-complete reactor kills the agent before it could ever propose any).
// Instead, the host types a "distill learnings, then card_complete" instruction
// into the session's live pane (or relaunches a dead session with it queued),
// so completion runs through the same agent-driven path as a spoken "complete
// this card". Pure resolve+render+deliver behind an injected `deliver`, exactly
// like deliverLearningComment; NodeHost wires `deliver` to queueToSession.

import type { DeliverCommentResult } from "@orden/host-api";

/** The delivered-state queueToSession reports back, before we map it. */
export type DeliveredState = "queued" | "relaunched" | "failed";

export interface RequestCompleteDeps {
  /** Read the session record from the vault (null = nothing to reach). */
  getSession: (id: string) => Promise<unknown | null>;
  /** Type `text` into the session's live pane (or relaunch it queued). */
  deliver: (sessionId: string, text: string) => Promise<DeliveredState>;
}

/** Render the user's checkmark click as the agent's completion procedure. */
export function renderCompleteRequest(): string {
  return (
    "The user marked this session complete in the orden UI — that is their explicit instruction to finish.\n\n" +
    "First distill what this session changed into learnings: call learning_propose once per proposed " +
    "README/ADR/AGENTS.md edit or new skill, passing the FULL post-change file content (not a diff). " +
    "Skip this when nothing was worth capturing.\n\n" +
    "Then call card_complete with a one- or two-sentence summary of what the session did."
  );
}

export async function requestSessionComplete(
  deps: RequestCompleteDeps,
  sessionId: string,
): Promise<DeliverCommentResult> {
  // No session record means there is no agent (and no conversation) to reach.
  const session = await deps.getSession(sessionId);
  if (!session) return { delivered: "not-linked" };

  const state = await deps.deliver(sessionId, renderCompleteRequest());
  return { delivered: state };
}
