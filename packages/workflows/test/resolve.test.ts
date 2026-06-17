import { describe, it, expect } from "vitest";
import { resolveSpec } from "../src/resolve";
import { DEFAULT_WORKFLOW } from "../src/default";
import type { PrimitiveStep, ProseStep } from "../src/types";

describe("resolveSpec (runbook)", () => {
  it("an empty override equals the base", () => {
    expect(resolveSpec({})).toEqual(DEFAULT_WORKFLOW);
  });

  it("overrides scalars while inheriting the runbook", () => {
    const r = resolveSpec({ name: "Code (push only)", description: "for quick fixes" });
    expect(r.name).toBe("Code (push only)");
    expect(r.description).toBe("for quick fixes");
    expect(r.steps).toEqual(DEFAULT_WORKFLOW.steps);
    expect(r.learningKinds).toEqual(DEFAULT_WORKFLOW.learningKinds);
  });

  it("merges agent settings field-by-field", () => {
    const r = resolveSpec({ agent: { isolate: false } });
    expect(r.agent).toEqual({
      harness: "claude",
      isolate: false,
      mode: "tui",
      gitGuard: true,
    });
  });

  it("child steps define the runbook and order, inheriting missing fields by id", () => {
    const r = resolveSpec({
      steps: [{ id: "implement", label: "Build" }, { id: "push" }],
    });
    expect(r.steps.map((s) => s.id)).toEqual(["implement", "push"]);
    const implement = r.steps.find((s) => s.id === "implement") as ProseStep;
    expect(implement.kind).toBe("prose"); // inherited
    expect(implement.label).toBe("Build"); // child wins
    expect(implement.role).toBe("active"); // inherited
    expect(implement.prose).toBe(
      (DEFAULT_WORKFLOW.steps.find((s) => s.id === "implement") as ProseStep).prose,
    );
    const push = r.steps.find((s) => s.id === "push") as PrimitiveStep;
    expect(push.kind).toBe("primitive");
    expect(push.action).toBe("push"); // inherited
  });

  it("a brand-new step stands alone with its given fields", () => {
    const r = resolveSpec({
      steps: [{ id: "deploy", kind: "primitive", label: "Deploy", role: "terminal", action: "merge" }],
    });
    expect(r.steps).toEqual([
      { id: "deploy", label: "Deploy", role: "terminal", kind: "primitive", action: "merge" },
    ]);
  });
});
