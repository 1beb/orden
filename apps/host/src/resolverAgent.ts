// Conflict resolver for the merge coordinator.
//
// The REAL resolver (D2) spawns an ephemeral agent in the integration worktree,
// hands it every contributing branch's intent + the conflict hunks, and lets it
// reconcile (commit), declare the goals incompatible, or report it can't verify.
// Until that lands, `conservativeResolver` is the safe default: it NEVER silently
// merges a textual conflict it can't reason about — every conflict escalates as
// an intent decision so the user picks which card's change wins.

import type { ResolverRunner, ResolverInput, ResolverOutcome } from "./mergeCoordinator";

const label = (r: { title?: string; cardId: string }): string => r.title || r.cardId;

export const conservativeResolver: ResolverRunner = async (
  input: ResolverInput,
): Promise<ResolverOutcome> => {
  const others = input.contributors.map(label).join(", ");
  return {
    kind: "intent-conflict",
    question:
      `"${label(input.incoming)}" conflicts with ${others || "earlier work"} in ` +
      `${input.conflictFiles.join(", ")}. Automatic reconciliation isn't enabled yet — ` +
      `which card's goal should win?`,
    // Chip values are card ids (resume matches the chosen winner against them).
    options: [input.incoming.cardId, ...input.contributors.map((c) => c.cardId)],
  };
};
