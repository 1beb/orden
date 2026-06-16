import { describe, it, expect } from "vitest";
import { ACTIONS, GATES } from "@orden/workflows";
import { ACTION_EXECUTORS, GATE_EXECUTORS } from "./workflowExecutors";

// The drift guard: the catalog (single source of truth in @orden/workflows) and the
// host's executor registry are authored in different packages and must stay in lockstep.
// This test fails the build the moment one gains or loses a primitive the other lacks.
describe("workflow executor registry contract", () => {
  it("registers exactly the catalog actions, no more, no fewer", () => {
    expect(Object.keys(ACTION_EXECUTORS).sort()).toEqual([...ACTIONS].sort());
  });

  it("registers exactly the catalog gates, no more, no fewer", () => {
    expect(Object.keys(GATE_EXECUTORS).sort()).toEqual([...GATES].sort());
  });

  it("keeps the unimplemented primitives explicit (no silent stubs)", () => {
    const pending = Object.entries(ACTION_EXECUTORS)
      .filter(([, v]) => !v.implemented)
      .map(([k]) => k)
      .sort();
    // Update this list (and wire the executor) when a pending primitive ships.
    expect(pending).toEqual(["merge", "verify"]);
  });

  it("every unimplemented primitive carries a note explaining the gap", () => {
    for (const [, v] of [
      ...Object.entries(ACTION_EXECUTORS),
      ...Object.entries(GATE_EXECUTORS),
    ]) {
      if (!v.implemented) expect(v.note, v.summary).toBeTruthy();
    }
  });
});
