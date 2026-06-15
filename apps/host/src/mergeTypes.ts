// Shared types for the merge coordinator: the integration queue records and the
// typed view of the coordinator-owned fields on a card. Cards are a loose
// `[k: string]: unknown` bag in the vault; these interfaces are how the
// coordinator reads/writes its slice. See
// docs/plans/2026-06-15-merge-coordinator-design.md.

export const MERGE_QUEUE_NS = "merge-queue";

export type MergeStatus =
  | "queued"
  | "merging"
  | "merged"
  | "skipped"
  | "blocked-intent"
  | "blocked-unverifiable";

// Written onto a blocked card when the coordinator escalates. Phrased at goal
// altitude — never diffs.
export interface IntegrationBlock {
  kind: "intent" | "unverifiable";
  /** e.g. "A removes X; B and C depend on X — which goal wins?" */
  question: string;
  /** One chip per contributing card (intent only, length >= 2). */
  options?: string[];
  /** Every colliding sibling (1..N), not just one. */
  otherCardIds?: string[];
  /** The winning card id, written when the user resolves. Drives resume. */
  chosen?: string;
}

// One row per integration attempt for a completed card.
export interface MergeQueueEntry {
  cardId: string;
  projectId: string;
  branch: string;
  /** = card.completedAt; the FIFO ordering key. */
  enqueuedAt: number;
  status: "queued" | "merging" | "merged" | "skipped" | "escalated";
  result?: "clean" | "resolved" | "intent-conflict" | "unverifiable";
  /** Integration tip after this entry applied (when merged). */
  integrationTip?: string;
  error?: string;
}

// Defaults for the integration boundary, resolved project-over-global. The
// verify (gate) and rebuild commands are LANGUAGE-AGNOSTIC and default EMPTY —
// the coordinator runs whatever shell command a project configures (pnpm,
// pytest, cargo test, go test, make, …) and bakes in no toolchain assumption.
// Empty verify => no semantic gate (textual merge-tree only); empty rebuild =>
// no post-merge build.
export const DEFAULT_INTEGRATION_MODE: "fast" | "measured" = "fast";
export const DEFAULT_INTEGRATION_VERIFY = "";
export const DEFAULT_INTEGRATION_REBUILD = "";
