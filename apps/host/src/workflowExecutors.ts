// The host-side executor registry for the workflow primitive catalog. Every catalog
// Action and Gate must have exactly one entry here; the contract test
// (workflows.contract.test.ts) asserts the bijection so the catalog in
// @orden/workflows and the host can never silently drift apart. Primitives that are
// not yet wired carry `implemented: false` with a note, rather than a silent stub, so
// the gap is visible (and the contract test pins the pending set).
import type { Action, Gate } from "@orden/workflows";

export type ExecutorKind = "host" | "agent" | "gate";

export interface PrimitiveExecutor {
  /** Who runs it: the host on a transition, the in-session agent, or a user pause. */
  kind: ExecutorKind;
  /** False = catalogued but not yet wired; the contract test tracks these. */
  implemented: boolean;
  /** Where/how it runs, for humans reading the registry. */
  summary: string;
  note?: string;
}

export const ACTION_EXECUTORS: Record<Action, PrimitiveExecutor> = {
  journal: {
    kind: "host",
    implemented: true,
    summary: "log completion to the journal + card log (cardJournal.ts)",
  },
  push: {
    kind: "host",
    implemented: true,
    summary: "push the session branch (publishReactor.ts / publishSession.ts)",
  },
  "open-pr": {
    kind: "host",
    implemented: true,
    summary: "open a PR via the prForge setting (publishSession.ts)",
  },
  merge: {
    kind: "host",
    implemented: false,
    summary: "merge the branch into its base",
    note: "not yet wired; today's built-in policy is never-merge (publishSession.ts)",
  },
  reap: {
    kind: "host",
    implemented: true,
    summary: "kill linked agent sessions + clean the worktree (cardReaper.ts)",
  },
  "propose-learnings": {
    kind: "agent",
    implemented: true,
    summary: "the agent calls learning_propose before completion (MCP)",
  },
  verify: {
    kind: "agent",
    implemented: false,
    summary: "run an agent against a criterion; fail/uncertain raises a card",
    note: "Stage 2 execution work",
  },
};

export const GATE_EXECUTORS: Record<Gate, PrimitiveExecutor> = {
  approve: {
    kind: "gate",
    implemented: true,
    summary: "pause for the user to approve a parked plan",
  },
  review: {
    kind: "gate",
    implemented: true,
    summary: "pause for the user to review rendered evidence before advancing",
  },
};
