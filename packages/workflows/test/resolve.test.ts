import { describe, it, expect } from "vitest";
import { resolveSpec } from "../src/resolve";
import { DEFAULT_WORKFLOW } from "../src/default";

describe("resolveSpec", () => {
  it("an empty override equals the base", () => {
    expect(resolveSpec({})).toEqual(DEFAULT_WORKFLOW);
  });

  it("overrides scalars while inheriting the rest", () => {
    const r = resolveSpec({ name: "Code (push only)", completion: "push" });
    expect(r.name).toBe("Code (push only)");
    expect(r.completion).toBe("push");
    expect(r.stages).toEqual(DEFAULT_WORKFLOW.stages);
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

  it("child stages define the pipeline and order, inheriting missing fields by id", () => {
    const r = resolveSpec({
      stages: [
        { id: "in-progress" },
        { id: "complete", label: "Ship", onEnter: ["push"] },
      ],
    });
    expect(r.stages.map((s) => s.id)).toEqual(["in-progress", "complete"]);
    const complete = r.stages.find((s) => s.id === "complete")!;
    expect(complete.label).toBe("Ship");
    expect(complete.role).toBe("terminal"); // inherited from base
    expect(complete.onEnter).toEqual(["push"]); // child wins
    const inProgress = r.stages.find((s) => s.id === "in-progress")!;
    expect(inProgress.label).toBe("In-progress"); // inherited
  });

  it("a brand-new stage id stands alone with empty defaults", () => {
    const r = resolveSpec({
      stages: [{ id: "draft", label: "Draft", role: "initial" }],
    });
    expect(r.stages).toEqual([
      { id: "draft", label: "Draft", role: "initial", gates: [], onEnter: [], onExit: [] },
    ]);
  });
});
