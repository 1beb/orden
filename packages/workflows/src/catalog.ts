/**
 * The closed primitive catalog: the single source of truth for everything orden
 * knows how to run. A workflow may reference only these; the host must register an
 * executor for each (enforced by a contract test in the host). Adding a primitive is
 * a contained change here plus its executor — never an ad-hoc switch elsewhere.
 */
import type { Action, Gate, StageRole } from "./types";

export const STAGE_ROLES = ["initial", "active", "waiting", "terminal"] as const;

export const GATES = ["approve", "review"] as const;

export const ACTIONS = [
  "journal",
  "push",
  "open-pr",
  "merge",
  "reap",
  "propose-learnings",
  "verify",
] as const;

/** Actions that are irreversible / outward-facing; the validator warns on these. */
export const IRREVERSIBLE_ACTIONS: ReadonlySet<Action> = new Set([
  "push",
  "open-pr",
  "merge",
]);

export const isStageRole = (s: string): s is StageRole =>
  (STAGE_ROLES as readonly string[]).includes(s);

export const isGate = (s: string): s is Gate =>
  (GATES as readonly string[]).includes(s);

export const isAction = (s: string): s is Action =>
  (ACTIONS as readonly string[]).includes(s);
