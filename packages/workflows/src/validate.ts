/**
 * Validates a (resolved) WorkflowSpec runbook. Errors are structural problems that make
 * a workflow unrunnable (references to primitives that do not exist, no terminal step).
 * Warnings are the design's footguns — surfaced at the confirm step so the operator
 * chooses knowingly; they are not walls.
 */
import { isAction, isGate, isRole } from "./catalog";
import type { GateStep, PrimitiveStep, ProseStep, WorkflowSpec } from "./types";

export interface ValidationResult {
  errors: string[];
  warnings: string[];
}

export function validateWorkflow(spec: WorkflowSpec): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // --- structural errors -------------------------------------------------
  for (const step of spec.steps) {
    if (!isRole(step.role)) {
      errors.push(`Step "${step.label}" has unknown role "${step.role}".`);
    }
    if (step.kind === "primitive" && !isAction((step as PrimitiveStep).action)) {
      errors.push(`Step "${step.label}" references unknown action "${(step as PrimitiveStep).action}".`);
    }
    if (step.kind === "gate" && !isGate((step as GateStep).gate)) {
      errors.push(`Step "${step.label}" references unknown gate "${(step as GateStep).gate}".`);
    }
  }
  if (!spec.steps.some((s) => s.role === "terminal")) {
    errors.push("Workflow has no terminal step; nothing can complete.");
  }

  // --- trade-off warnings ------------------------------------------------
  const primitives = spec.steps.filter((s): s is PrimitiveStep => s.kind === "primitive");
  const hasApprove = spec.steps.some((s) => s.kind === "gate" && (s as GateStep).gate === "approve");

  const mergeIdx = spec.steps.findIndex(
    (s) => s.kind === "primitive" && (s as PrimitiveStep).action === "merge",
  );
  if (mergeIdx >= 0) {
    const reviewBefore = spec.steps
      .slice(0, mergeIdx)
      .some((s) => s.kind === "gate" && (s as GateStep).gate === "review");
    if (!reviewBefore) {
      warnings.push(
        "This merges work you haven't reviewed — there is no review gate before the merge.",
      );
    }
  }

  if (spec.agent?.isolate === false && spec.agent?.gitGuard === false) {
    warnings.push(
      "Isolation and the git guard are both off — the agent can run destructive git in your real working tree.",
    );
  }

  if (!hasApprove) {
    warnings.push(
      "No approval gate — the agent starts working immediately, with no plan sign-off.",
    );
  }

  if (!primitives.some((s) => s.action === "push" || s.action === "open-pr" || s.action === "merge")) {
    warnings.push(
      "Nothing publishes — work stays on the branch when the workflow completes.",
    );
  }

  // Multi-model prose steps must declare how their parallel attempts reconcile, and an
  // aggregation is pointless without more than one model.
  for (const step of spec.steps) {
    if (step.kind !== "prose") continue;
    const ps = step as ProseStep;
    const models = ps.agent?.models ?? spec.agent?.models ?? [];
    if (models.length > 1 && !ps.aggregate) {
      warnings.push(
        `Step "${ps.label}" runs ${models.length} models but has no aggregation step; their outputs won't be reconciled.`,
      );
    }
    if (ps.aggregate && models.length <= 1) {
      warnings.push(
        `Step "${ps.label}" has an aggregation step but only one model, so there is nothing to aggregate.`,
      );
    }
  }

  return { errors, warnings };
}
