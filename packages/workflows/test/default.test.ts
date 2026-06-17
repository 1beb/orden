import { describe, it, expect } from "vitest";
import { DEFAULT_WORKFLOW } from "../src/default";
import type { GateStep, PrimitiveStep } from "../src/types";

const actions = () =>
  DEFAULT_WORKFLOW.steps
    .filter((s): s is PrimitiveStep => s.kind === "primitive")
    .map((s) => s.action);
const gates = () =>
  DEFAULT_WORKFLOW.steps
    .filter((s): s is GateStep => s.kind === "gate")
    .map((s) => s.gate);

describe("default workflow (runbook)", () => {
  it("is an ordered runbook of typed steps", () => {
    expect(DEFAULT_WORKFLOW.steps.map((s) => [s.kind, s.role])).toEqual([
      ["prose", "initial"],
      ["gate", "waiting"],
      ["prose", "active"],
      ["gate", "waiting"],
      ["primitive", "terminal"],
      ["primitive", "terminal"],
      ["primitive", "terminal"],
      ["primitive", "terminal"],
      ["primitive", "terminal"],
    ]);
  });

  it("step ids are slugs of their labels", () => {
    expect(DEFAULT_WORKFLOW.steps.map((s) => s.id)).toEqual([
      "plan",
      "approve-the-plan",
      "implement",
      "review-the-evidence",
      "propose-learnings",
      "journal",
      "push",
      "open-a-pr",
      "reap",
    ]);
  });

  it("gates plan approval then evidence review", () => {
    expect(gates()).toEqual(["approve", "review"]);
  });

  it("publishes and reaps at the terminal, never merges", () => {
    expect(actions()).toEqual([
      "propose-learnings",
      "journal",
      "push",
      "open-pr",
      "reap",
    ]);
    expect(actions()).not.toContain("merge");
  });

  it("defaults the agent to isolated claude TUI with the git guard on", () => {
    expect(DEFAULT_WORKFLOW.agent).toEqual({
      harness: "claude",
      isolate: true,
      mode: "tui",
      gitGuard: true,
    });
  });

  it("carries the learning kinds, a dirty-tree policy, and a description", () => {
    expect(DEFAULT_WORKFLOW.learningKinds).toEqual([
      "readme",
      "adr",
      "agents",
      "skill",
    ]);
    expect(DEFAULT_WORKFLOW.dirtyTree).toBe("ask");
    expect(typeof DEFAULT_WORKFLOW.description).toBe("string");
    expect(DEFAULT_WORKFLOW.description!.length).toBeGreaterThan(0);
  });
});
