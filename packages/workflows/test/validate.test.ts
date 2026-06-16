import { describe, it, expect } from "vitest";
import { validateWorkflow } from "../src/validate";
import { DEFAULT_WORKFLOW } from "../src/default";
import type { WorkflowSpec } from "../src/types";

const clone = (): WorkflowSpec => JSON.parse(JSON.stringify(DEFAULT_WORKFLOW));

describe("validateWorkflow", () => {
  it("passes the default with no errors or warnings", () => {
    expect(validateWorkflow(DEFAULT_WORKFLOW)).toEqual({ errors: [], warnings: [] });
  });

  it("warns when merging without a review gate", () => {
    const spec = clone();
    spec.completion = "push+merge";
    const terminal = spec.stages.find((s) => s.role === "terminal")!;
    terminal.gates = terminal.gates.filter((g) => g !== "review");
    if (!terminal.onEnter.includes("merge")) terminal.onEnter.push("merge");
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
    for (const s of spec.stages) s.gates = s.gates.filter((g) => g !== "approve");
    expect(
      validateWorkflow(spec).warnings.some((w) => /approv|sign-off/i.test(w)),
    ).toBe(true);
  });

  it("warns when the workflow publishes nothing", () => {
    const spec = clone();
    spec.completion = "none";
    const terminal = spec.stages.find((s) => s.role === "terminal")!;
    terminal.onEnter = ["journal", "reap", "propose-learnings"];
    expect(
      validateWorkflow(spec).warnings.some((w) => /publish|branch/i.test(w)),
    ).toBe(true);
  });

  it("errors on a primitive that is not in the catalog", () => {
    const spec = clone();
    const terminal = spec.stages.find((s) => s.role === "terminal")!;
    (terminal.onEnter as string[]).push("deploy-to-prod");
    const { errors } = validateWorkflow(spec);
    expect(errors.some((e) => /deploy-to-prod/.test(e))).toBe(true);
  });

  it("errors when there is no terminal stage", () => {
    const spec = clone();
    spec.stages = spec.stages.filter((s) => s.role !== "terminal");
    expect(validateWorkflow(spec).errors.some((e) => /terminal/i.test(e))).toBe(true);
  });
});
