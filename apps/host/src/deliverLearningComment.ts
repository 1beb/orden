// Deliver a learning's review comment back to the agent that proposed it. The
// user's feedback is rendered into an actionable message and typed into the
// proposing session's live pane (queued for its next turn) — or, if that session
// is dead (the usual case by review time, since completing reaps the agent), the
// session is relaunched with the message queued. The pure resolve+render+deliver
// logic lives here behind an injected `deliver` so it's unit-testable without
// tmux; NodeHost wires `deliver` to queueToSession(..., defaultPaneOps(...)).

import type { DeliverCommentResult, Learning } from "@orden/host-api";

/** The delivered-state queueToSession reports back, before we map it. */
export type DeliveredState = "queued" | "relaunched" | "failed";

export interface DeliverCommentDeps {
  /** Read the learning record from the vault. */
  getLearning: (id: string) => Promise<Learning | null>;
  /** Type `text` into the session's live pane (or relaunch it queued). */
  deliver: (sessionId: string, text: string) => Promise<DeliveredState>;
}

/** Render the user's review comment as an actionable revise instruction for the agent. */
export function renderComment(learning: Learning, text: string): string {
  return (
    `The user reviewed your proposed learning "${learning.title}" (${learning.targetPath}) and asked you to revise it.\n\n` +
    `Their instruction: ${text}\n\n` +
    `Re-run learning_propose with id="${learning.id}" and the full updated file content (NOT a diff). ` +
    `This replaces the existing proposal in place for them to review again.`
  );
}

export async function deliverLearningComment(
  deps: DeliverCommentDeps,
  learningId: string,
  text: string,
): Promise<DeliverCommentResult> {
  const learning = await deps.getLearning(learningId);
  if (!learning) throw new Error(`learning not found: ${learningId}`);

  // The proposing session is the only thing that can act on the feedback. With no
  // sessionId on the record there's nothing to reach — report not-linked (no deliver).
  const sessionId = learning.sessionId;
  if (!sessionId) return { delivered: "not-linked" };

  const state = await deps.deliver(sessionId, renderComment(learning, text));
  return { delivered: state };
}
