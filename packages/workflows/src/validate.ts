/**
 * Validates a (resolved) WorkflowSpec. Errors are structural problems that make a
 * workflow unrunnable (references to primitives that do not exist, no terminal stage).
 * Warnings are the design's footguns — surfaced at the confirm step so the operator
 * chooses knowingly; they are not walls.
 */
import { isAction, isGate, isStageRole } from "./catalog";
import type { WorkflowSpec } from "./types";

export interface ValidationResult {
  errors: string[];
  warnings: string[];
}

export function validateWorkflow(spec: WorkflowSpec): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // --- structural errors -------------------------------------------------
  for (const stage of spec.stages) {
    if (!isStageRole(stage.role)) {
      errors.push(`Stage "${stage.label}" has unknown role "${stage.role}".`);
    }
    for (const g of stage.gates as string[]) {
      if (!isGate(g)) errors.push(`Stage "${stage.label}" references unknown gate "${g}".`);
    }
    for (const a of [...stage.onEnter, ...stage.onExit] as string[]) {
      if (!isAction(a)) {
        errors.push(`Stage "${stage.label}" references unknown action "${a}".`);
      }
    }
  }
  if (!spec.stages.some((s) => s.role === "terminal")) {
    errors.push("Workflow has no terminal stage; nothing can complete.");
  }

  // --- trade-off warnings ------------------------------------------------
  const hasReviewGate = spec.stages.some((s) => s.gates.includes("review"));
  const hasApproveGate = spec.stages.some((s) => s.gates.includes("approve"));
  const merges =
    spec.completion === "push+merge" ||
    spec.stages.some((s) => s.onEnter.includes("merge"));
  if (merges && !hasReviewGate) {
    warnings.push(
      "This merges work you haven't reviewed — there is no review gate before it.",
    );
  }

  const isolate = spec.agent?.isolate;
  const gitGuard = spec.agent?.gitGuard;
  if (isolate === false && gitGuard === false) {
    warnings.push(
      "Isolation and the git guard are both off — the agent can run destructive git in your real working tree.",
    );
  }

  if (!hasApproveGate) {
    warnings.push(
      "No approval gate — the agent starts working immediately, with no plan sign-off.",
    );
  }

  if (spec.completion === "none") {
    warnings.push(
      "Nothing publishes — work stays on the branch when the workflow completes.",
    );
  }

  // Multi-model fan-out must declare how its parallel attempts are reconciled, and
  // an aggregation step is pointless without more than one model to reconcile.
  for (const stage of spec.stages) {
    const models = stage.agent?.models ?? spec.agent?.models ?? [];
    if (models.length > 1 && !stage.aggregate) {
      warnings.push(
        `Stage "${stage.label}" runs ${models.length} models but has no aggregation step; their outputs won't be reconciled.`,
      );
    }
    if (stage.aggregate && models.length <= 1) {
      warnings.push(
        `Stage "${stage.label}" has an aggregation step but only one model, so there is nothing to aggregate.`,
      );
    }
  }

  return { errors, warnings };
}
