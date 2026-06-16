import { describe, it, expect } from "vitest";
import { DEFAULT_WORKFLOW } from "../src/default";

describe("default workflow", () => {
  it("has today's four stages in order with correct roles", () => {
    expect(DEFAULT_WORKFLOW.stages.map((s) => [s.label, s.role])).toEqual([
      ["Planning", "initial"],
      ["In-progress", "active"],
      ["Blocked", "waiting"],
      ["Complete", "terminal"],
    ]);
  });

  it("ids are slugs of the labels", () => {
    expect(DEFAULT_WORKFLOW.stages.map((s) => s.id)).toEqual([
      "planning",
      "in-progress",
      "blocked",
      "complete",
    ]);
  });

  it("gates plan approval and evidence review", () => {
    const planning = DEFAULT_WORKFLOW.stages.find((s) => s.role === "initial")!;
    expect(planning.gates).toContain("approve");
    expect(DEFAULT_WORKFLOW.stages.some((s) => s.gates.includes("review"))).toBe(true);
  });

  it("publishes and reaps on complete, never merges", () => {
    const terminal = DEFAULT_WORKFLOW.stages.find((s) => s.role === "terminal")!;
    expect(terminal.onEnter).toEqual(
      expect.arrayContaining([
        "journal",
        "push",
        "open-pr",
        "reap",
        "propose-learnings",
      ]),
    );
    expect(terminal.onEnter).not.toContain("merge");
    expect(DEFAULT_WORKFLOW.completion).toBe("push+pr");
  });

  it("defaults agent to isolated claude TUI with the git guard on", () => {
    expect(DEFAULT_WORKFLOW.agent).toEqual({
      harness: "claude",
      isolate: true,
      mode: "tui",
      gitGuard: true,
    });
  });

  it("carries the four learning kinds and asks about a dirty tree", () => {
    expect(DEFAULT_WORKFLOW.learningKinds).toEqual([
      "readme",
      "adr",
      "agents",
      "skill",
    ]);
    expect(DEFAULT_WORKFLOW.dirtyTree).toBe("ask");
  });
});
