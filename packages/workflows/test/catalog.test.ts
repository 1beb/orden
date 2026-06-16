import { describe, it, expect } from "vitest";
import {
  STAGE_ROLES,
  GATES,
  ACTIONS,
  IRREVERSIBLE_ACTIONS,
  isAction,
  isGate,
  isStageRole,
} from "../src/catalog";

describe("catalog", () => {
  it("enumerates the closed primitive sets", () => {
    expect([...STAGE_ROLES]).toEqual(["initial", "active", "waiting", "terminal"]);
    expect([...GATES]).toEqual(["approve", "review"]);
    expect([...ACTIONS]).toEqual([
      "journal",
      "push",
      "open-pr",
      "merge",
      "reap",
      "propose-learnings",
      "verify",
    ]);
  });

  it("marks the irreversible/outward-facing actions", () => {
    expect([...IRREVERSIBLE_ACTIONS].sort()).toEqual(["merge", "open-pr", "push"]);
  });

  it("guards reject unknown ids", () => {
    expect(isAction("push")).toBe(true);
    expect(isAction("nope")).toBe(false);
    expect(isGate("approve")).toBe(true);
    expect(isGate("ship")).toBe(false);
    expect(isStageRole("terminal")).toBe(true);
    expect(isStageRole("done")).toBe(false);
  });
});
