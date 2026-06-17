import { describe, it, expect } from "vitest";
import { PRESET_WORKFLOWS } from "../src/presets";
import { validateWorkflow } from "../src/validate";

describe("preset workflows", () => {
  it("ships the built-in library, default first", () => {
    expect(PRESET_WORKFLOWS.map((w) => w.name)).toEqual([
      "default",
      "analysis",
      "bugfix",
      "quick-fix",
      "release",
    ]);
  });

  it("every preset has a description for agent-suggest + the picker", () => {
    for (const w of PRESET_WORKFLOWS) {
      expect(w.description, w.name).toBeTruthy();
    }
  });

  it("every preset is a warning-free, error-free exemplar", () => {
    for (const w of PRESET_WORKFLOWS) {
      const { errors, warnings } = validateWorkflow(w);
      expect(errors, `${w.name} errors`).toEqual([]);
      expect(warnings, `${w.name} warnings`).toEqual([]);
    }
  });

  it("the release preset opts into merge, gated behind a review", () => {
    const release = PRESET_WORKFLOWS.find((w) => w.name === "release")!;
    const ids = release.steps.map((s) => s.id);
    expect(ids).toContain("merge");
    // a review gate precedes the merge step
    const reviewIdx = release.steps.findIndex((s) => s.kind === "gate" && s.id === "review-the-evidence");
    const mergeIdx = release.steps.findIndex((s) => s.id === "merge");
    expect(reviewIdx).toBeGreaterThanOrEqual(0);
    expect(reviewIdx).toBeLessThan(mergeIdx);
  });
});
