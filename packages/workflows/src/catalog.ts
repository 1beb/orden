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
  // Lifecycle / publish
  "journal",
  "push",
  "open-pr",
  "merge",
  "reap",
  "propose-learnings",
  // Generic, parameterized (the long-tail keystone)
  "run",
  "check",
  // Review / evidence
  "capture",
  "code-review",
  // Communication
  "notify",
  // Agent verify
  "verify",
] as const;

/** Actions that are irreversible / outward-facing; the validator warns on these. */
export const IRREVERSIBLE_ACTIONS: ReadonlySet<Action> = new Set([
  "push",
  "open-pr",
  "merge",
]);

/**
 * Actions whose outcome (pass/fail) the host evaluates to drive conditional
 * routing. `check` gates on exit code / output match; `run` and `verify` report
 * pass/fail too. Other actions always pass. Used by the runbook engine to decide
 * branching after a primitive step.
 */
export const GATING_ACTIONS: ReadonlySet<Action> = new Set(["check", "run", "verify"]);

export const isStageRole = (s: string): s is StageRole =>
  (STAGE_ROLES as readonly string[]).includes(s);

export const isGate = (s: string): s is Gate =>
  (GATES as readonly string[]).includes(s);

export const isAction = (s: string): s is Action =>
  (ACTIONS as readonly string[]).includes(s);
