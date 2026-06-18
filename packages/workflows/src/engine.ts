/**
 * The pure runbook engine: a step-walking state machine over a resolved
 * WorkflowSpec. This module is the deterministic control-flow brain — it holds
 * NO host state and performs NO effects. The host runner (apps/host) persists a
 * {@link RunState}, invokes executors, and calls {@link advance} with each
 * step's outcome; this module decides where the runbook goes next.
 *
 * Control flow is host-evaluated (sequence + conditional routing on a step
 * outcome + one rework loop via `goto`); the agent is the effect inside a prose
 * step, never the router. Gates are durable vault suspensions: the runner parks
 * on a {@link gateKey}, and the operator's decision is the resume signal.
 *
 * See docs/plans/2026-06-17-configurable-workflows-consolidated.md.
 */
import { GATING_ACTIONS } from "./catalog";
import type { GateStep, PrimitiveStep, Step, WorkflowSpec } from "./types";

/** The kanban lane a step projects onto (mirrors @orden/outliner LifecycleState). */
export type BoardColumn = "planning" | "in-progress" | "blocked" | "complete";

/** Outcome of a gating primitive (`check`/`run`/`verify`); non-gating always pass. */
export type StepOutcome = "pass" | "fail";

/** An operator's decision on a gate step. */
export type GateDecision = "approve" | "reject";

/** The signal the host feeds {@link advance} after handling the current step. */
export type AdvanceSignal = StepOutcome | GateDecision | "complete";

/** The status of a runbook run. */
export type RunStatus = "running" | "gate-parked" | "done" | "parked-dirty";

/**
 * A runbook run's durable progress. Persisted by the host in the vault (keyed by
 * card id), so a gate suspension or a host restart loses nothing.
 */
export interface RunState {
  cardId: string;
  workflowName: string;
  /** Index into the resolved runbook's `steps[]`. */
  stepIndex: number;
  status: RunStatus;
  /** Reason text when `status === "parked-dirty"`. */
  parkedReason?: string;
  /** Ordered log of completed steps + their outcomes (audit + rework depth). */
  history: { stepId: string; outcome: AdvanceSignal; at: number }[];
}

/** A fresh run at the first step. */
export function initialRunState(cardId: string, workflowName: string): RunState {
  return { cardId, workflowName, stepIndex: 0, status: "running", history: [] };
}

/** The step the run is currently on, or undefined past the end. */
export function activeStep(spec: WorkflowSpec, run: RunState): Step | undefined {
  return spec.steps[run.stepIndex];
}

/**
 * The kanban column the active step projects onto. Authoring is a runbook; the
 * board is the derived view. initial→planning, active→in-progress,
 * waiting→blocked; a gate-park or a dirty park is blocked; done is complete.
 */
export function projectColumn(run: RunState, spec: WorkflowSpec): BoardColumn {
  if (run.status === "done") return "complete";
  if (run.status === "gate-parked" || run.status === "parked-dirty") return "blocked";
  const step = spec.steps[run.stepIndex];
  if (!step) return "complete";
  switch (step.role) {
    case "initial":
      return "planning";
    case "active":
      return "in-progress";
    case "waiting":
      return "blocked";
    case "terminal":
      return "in-progress";
  }
}

/** The vault key an operator's gate decision lands on (the resume signal). */
export function gateKey(cardId: string, stepId: string): string {
  return `gate:${cardId}:${stepId}`;
}

/**
 * Compute the next run-state given a signal for the current step. Pure: decides
 * stepIndex + status only — the host runner performs the effects and persists.
 *
 * - prose + "complete"            → next step
 * - primitive + "pass"            → next step
 * - primitive + "fail"            → `onFail.goto` (rework loop) or park-dirty
 * - gate + "approve"              → next step
 * - gate + "reject"               → `onReject.goto` or stay parked
 *
 * Arriving at a gate step parks the run (gate-parked); running past the last
 * step completes it (done). A mismatched signal for the step kind is ignored.
 */
export function advance(
  spec: WorkflowSpec,
  run: RunState,
  signal: AdvanceSignal,
  now: number = Date.now(),
): RunState {
  if (run.status === "done") return run;
  const step = spec.steps[run.stepIndex];
  if (!step) return { ...run, status: "done" };

  const record = (outcome: AdvanceSignal): RunState["history"][number] => ({
    stepId: step.id,
    outcome,
    at: now,
  });

  // Resolve the target index for the advance, or a park.
  let target: number | "park-dirty" | "stay-parked" | "ignore" = "ignore";

  if (step.kind === "prose") {
    if (signal === "complete") target = run.stepIndex + 1;
  } else if (step.kind === "primitive") {
    const ps = step as PrimitiveStep;
    const canFail = GATING_ACTIONS.has(ps.action);
    if (signal === "pass" || !canFail) {
      target = run.stepIndex + 1;
    } else if (signal === "fail") {
      const goto = ps.onFail?.goto;
      target = goto ? indexOfStep(spec, goto) ?? "park-dirty" : "park-dirty";
    }
  } else {
    // gate
    if (signal === "approve") {
      target = run.stepIndex + 1;
    } else if (signal === "reject") {
      const gs = step as GateStep;
      const goto = gs.onReject?.goto;
      target = goto ? indexOfStep(spec, goto) ?? "stay-parked" : "stay-parked";
    }
  }

  if (target === "ignore") return run;

  const history = [...run.history, record(signal)];

  if (target === "park-dirty") {
    return {
      ...run,
      status: "parked-dirty",
      parkedReason: `Step "${step.label}" could not complete cleanly.`,
      history,
    };
  }
  if (target === "stay-parked") {
    return { ...run, status: "gate-parked", history };
  }

  // Moving to a concrete step index.
  if (target >= spec.steps.length) {
    return { ...run, stepIndex: target, status: "done", history };
  }
  const arrived = spec.steps[target];
  const status: RunStatus = arrived.kind === "gate" ? "gate-parked" : "running";
  return { ...run, stepIndex: target, status, history };
}

function indexOfStep(spec: WorkflowSpec, id: string): number | undefined {
  const idx = spec.steps.findIndex((s) => s.id === id);
  return idx >= 0 ? idx : undefined;
}
