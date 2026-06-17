import { describe, it, expect } from "vitest";
import { validateWorkflow } from "../src/validate";
import { DEFAULT_WORKFLOW } from "../src/default";
import type { GateStep, PrimitiveStep, ProseStep, WorkflowSpec } from "../src/types";

const clone = (): WorkflowSpec => JSON.parse(JSON.stringify(DEFAULT_WORKFLOW));
const proseStep = (spec: WorkflowSpec, id: string) =>
  spec.steps.find((s): s is ProseStep => s.kind === "prose" && s.id === id)!;

describe("validateWorkflow (runbook)", () => {
  it("passes the default with no errors or warnings", () => {
    expect(validateWorkflow(DEFAULT_WORKFLOW)).toEqual({ errors: [], warnings: [] });
  });

  it("warns when a merge step has no preceding review gate", () => {
    const spec = clone();
    spec.steps = spec.steps.filter((s) => !(s.kind === "gate" && (s as GateStep).gate === "review"));
    spec.steps.push({ id: "merge", label: "Merge", role: "terminal", kind: "primitive", action: "merge" });
    const { errors, warnings } = validateWorkflow(spec);
    expect(errors).toEqual([]);
    expect(warnings.some((w) => /review/i.test(w))).toBe(true);
  });

  it("warns when isolation and the git guard are both off", () => {
    const spec = clone();
    spec.agent = { ...spec.agent, isolate: false, gitGuard: false };
    expect(validateWorkflow(spec).warnings.some((w) => /working tree/i.test(w))).toBe(true);
  });

  it("warns when nothing gates plan approval", () => {
    const spec = clone();
    spec.steps = spec.steps.filter((s) => !(s.kind === "gate" && (s as GateStep).gate === "approve"));
    expect(validateWorkflow(spec).warnings.some((w) => /approv|sign-off/i.test(w))).toBe(true);
  });

  it("warns when the workflow publishes nothing", () => {
    const spec = clone();
    spec.steps = spec.steps.filter(
      (s) => !(s.kind === "primitive" && ["push", "open-pr", "merge"].includes((s as PrimitiveStep).action)),
    );
    expect(validateWorkflow(spec).warnings.some((w) => /publish|branch/i.test(w))).toBe(true);
  });

  it("errors on a primitive whose action is not in the catalog", () => {
    const spec = clone();
    spec.steps.push({ id: "deploy", label: "Deploy", role: "terminal", kind: "primitive", action: "deploy-to-prod" as PrimitiveStep["action"] });
    expect(validateWorkflow(spec).errors.some((e) => /deploy-to-prod/.test(e))).toBe(true);
  });

  it("errors when there is no terminal step", () => {
    const spec = clone();
    spec.steps = spec.steps.filter((s) => s.role !== "terminal");
    expect(validateWorkflow(spec).errors.some((e) => /terminal/i.test(e))).toBe(true);
  });

  it("warns when a multi-model prose step has no aggregation", () => {
    const spec = clone();
    proseStep(spec, "implement").agent = { models: ["opus", "sonnet"] };
    expect(validateWorkflow(spec).warnings.some((w) => /aggregat/i.test(w))).toBe(true);
  });

  it("does not warn when a multi-model prose step has an aggregation", () => {
    const spec = clone();
    const step = proseStep(spec, "implement");
    step.agent = { models: ["opus", "sonnet"] };
    step.aggregate = { model: "opus" };
    expect(validateWorkflow(spec).warnings.some((w) => /aggregat/i.test(w))).toBe(false);
  });

  it("warns when an aggregation step has nothing to aggregate", () => {
    const spec = clone();
    const step = proseStep(spec, "implement");
    step.agent = { models: ["opus"] };
    step.aggregate = { model: "opus" };
    expect(validateWorkflow(spec).warnings.some((w) => /aggregat/i.test(w))).toBe(true);
  });
});
