import { describe, it, expect } from "vitest";
import {
  initialRunState,
  activeStep,
  projectColumn,
  advance,
  gateKey,
  type RunState,
  type AdvanceSignal,
} from "../src/engine";
import { DEFAULT_WORKFLOW, resolveSpec, type WorkflowSpec } from "../src/index";

// A compact runbook: plan -> approve(gate) -> implement -> check -> review(gate)
// -> journal -> push -> reap. The `check` fails back to `implement` (rework loop).
function runbook(): WorkflowSpec {
  return resolveSpec({
    name: "test",
    steps: [
      { id: "plan", label: "Plan", role: "initial", kind: "prose", prose: "Plan it." },
      { id: "approve", label: "Approve", role: "waiting", kind: "gate", gate: "approve" },
      { id: "implement", label: "Implement", role: "active", kind: "prose", prose: "Do it." },
      {
        id: "check",
        label: "Check",
        role: "active",
        kind: "primitive",
        action: "check",
        params: { command: "pnpm test" },
        onFail: { goto: "implement" },
      },
      { id: "review", label: "Review", role: "waiting", kind: "gate", gate: "review", onReject: { goto: "implement" } },
      { id: "journal", label: "Journal", role: "terminal", kind: "primitive", action: "journal" },
      { id: "push", label: "Push", role: "terminal", kind: "primitive", action: "push" },
      { id: "reap", label: "Reap", role: "terminal", kind: "primitive", action: "reap" },
    ],
  });
}

describe("initialRunState", () => {
  it("starts at step 0, running", () => {
    const r = initialRunState("c1", "test");
    expect(r.cardId).toBe("c1");
    expect(r.workflowName).toBe("test");
    expect(r.stepIndex).toBe(0);
    expect(r.status).toBe("running");
    expect(r.history).toEqual([]);
  });
});

describe("activeStep", () => {
  it("returns the step at the current index", () => {
    const spec = runbook();
    const r = initialRunState("c1", "test");
    expect(activeStep(spec, r)?.id).toBe("plan");
  });
  it("returns undefined past the last step", () => {
    const spec = runbook();
    const r: RunState = { ...initialRunState("c1", "test"), stepIndex: 99, status: "done" };
    expect(activeStep(spec, r)).toBeUndefined();
  });
});

describe("projectColumn", () => {
  const spec = runbook();
  it("initial role -> planning", () => {
    expect(projectColumn(initialRunState("c1", "test"), spec)).toBe("planning");
  });
  it("active role -> in-progress", () => {
    const r = advance(spec, initialRunState("c1", "test"), "complete"); // past plan
    expect(projectColumn(r, spec)).toBe("blocked"); // now at approve gate -> blocked
  });
  it("gate-parked -> blocked", () => {
    const r = advance(spec, initialRunState("c1", "test"), "complete");
    expect(r.status).toBe("gate-parked");
    expect(projectColumn(r, spec)).toBe("blocked");
  });
  it("done -> complete", () => {
    const r: RunState = { ...initialRunState("c1", "test"), status: "done" };
    expect(projectColumn(r, spec)).toBe("complete");
  });
  it("parked-dirty -> blocked", () => {
    const r: RunState = { ...initialRunState("c1", "test"), status: "parked-dirty", parkedReason: "dirty tree" };
    expect(projectColumn(r, spec)).toBe("blocked");
  });
});

describe("advance — sequence", () => {
  const spec = runbook();
  it("walks prose -> gate -> prose -> primitives -> done", () => {
    let r = initialRunState("c1", "test");
    // plan (prose) complete -> arrives at approve gate (parked)
    r = advance(spec, r, "complete");
    expect(r.stepIndex).toBe(1);
    expect(r.status).toBe("gate-parked");
    // approve -> arrives at implement (prose, running)
    r = advance(spec, r, "approve");
    expect(r.stepIndex).toBe(2);
    expect(r.status).toBe("running");
    // implement complete -> arrives at check (primitive, running)
    r = advance(spec, r, "complete");
    expect(r.stepIndex).toBe(3);
    expect(r.status).toBe("running");
    // check passes -> arrives at review gate (parked)
    r = advance(spec, r, "pass");
    expect(r.stepIndex).toBe(4);
    expect(r.status).toBe("gate-parked");
    // review approve -> journal (terminal primitive, running)
    r = advance(spec, r, "approve");
    expect(r.stepIndex).toBe(5);
    expect(r.status).toBe("running");
    // journal passes -> push
    r = advance(spec, r, "pass");
    expect(r.stepIndex).toBe(6);
    // push passes -> reap
    r = advance(spec, r, "pass");
    expect(r.stepIndex).toBe(7);
    // reap passes -> done
    r = advance(spec, r, "pass");
    expect(r.status).toBe("done");
    expect(r.stepIndex).toBe(8);
  });
});

describe("advance — conditional routing on outcome", () => {
  const spec = runbook();
  it("a failing check with onFail.goto loops back to implement", () => {
    // Walk to the check step (index 3).
    let r = initialRunState("c1", "test");
    r = advance(spec, r, "complete"); // -> approve gate
    r = advance(spec, r, "approve"); // -> implement
    r = advance(spec, r, "complete"); // -> check
    expect(r.stepIndex).toBe(3);
    // check FAILS -> onFail.goto implement (index 2): rework loop
    r = advance(spec, r, "fail");
    expect(r.stepIndex).toBe(2);
    expect(r.status).toBe("running");
    expect(r.history.at(-1)?.outcome).toBe("fail");
  });

  it("a failing check with NO onFail parks dirty with a reason", () => {
    const spec2 = resolveSpec({
      name: "t2",
      steps: [
        { id: "do", label: "Do", role: "active", kind: "prose", prose: "x" },
        { id: "check", label: "Check", role: "active", kind: "primitive", action: "check" },
        { id: "push", label: "Push", role: "terminal", kind: "primitive", action: "push" },
      ],
    });
    let r = initialRunState("c1", "t2");
    r = advance(spec2, r, "complete"); // -> check
    r = advance(spec2, r, "fail"); // no onFail -> park
    expect(r.status).toBe("parked-dirty");
    expect(r.parkedReason).toMatch(/check/i);
    expect(r.stepIndex).toBe(1); // stays on the failing step
  });
});

describe("advance — gate reject", () => {
  const spec = runbook();
  it("review reject with onReject.goto loops back to implement", () => {
    let r = initialRunState("c1", "test");
    r = advance(spec, r, "complete"); // -> approve
    r = advance(spec, r, "approve"); // -> implement
    r = advance(spec, r, "complete"); // -> check
    r = advance(spec, r, "pass"); // -> review gate
    expect(r.stepIndex).toBe(4);
    // reject -> onReject.goto implement (index 2)
    r = advance(spec, r, "reject");
    expect(r.stepIndex).toBe(2);
    expect(r.status).toBe("running");
  });

  it("reject with NO onReject stays parked (operator must act)", () => {
    const spec2 = resolveSpec({
      name: "t2",
      steps: [
        { id: "do", label: "Do", role: "active", kind: "prose", prose: "x" },
        { id: "approve", label: "Approve", role: "waiting", kind: "gate", gate: "approve" },
        { id: "push", label: "Push", role: "terminal", kind: "primitive", action: "push" },
      ],
    });
    let r = initialRunState("c1", "t2");
    r = advance(spec2, r, "complete"); // -> approve gate
    r = advance(spec2, r, "reject"); // no onReject -> stays parked
    expect(r.status).toBe("gate-parked");
    expect(r.stepIndex).toBe(1);
  });
});

describe("advance — default workflow is well-formed", () => {
  it("the default runbook walks to done through its terminal primitives", () => {
    let r = initialRunState("c1", "default");
    // plan -> approve gate
    r = advance(DEFAULT_WORKFLOW, r, "complete");
    expect(r.status).toBe("gate-parked");
    // approve -> implement
    r = advance(DEFAULT_WORKFLOW, r, "approve");
    expect(activeStep(DEFAULT_WORKFLOW, r)?.id).toBe("implement");
    // implement -> review gate
    r = advance(DEFAULT_WORKFLOW, r, "complete");
    expect(r.status).toBe("gate-parked");
    expect(activeStep(DEFAULT_WORKFLOW, r)?.id).toBe("review-the-evidence");
    // review approve -> propose-learnings (terminal)
    r = advance(DEFAULT_WORKFLOW, r, "approve");
    expect(activeStep(DEFAULT_WORKFLOW, r)?.id).toBe("propose-learnings");
    // walk the remaining terminal primitives to done
    r = advance(DEFAULT_WORKFLOW, r, "pass"); // propose-learnings
    r = advance(DEFAULT_WORKFLOW, r, "pass"); // journal
    r = advance(DEFAULT_WORKFLOW, r, "pass"); // push
    r = advance(DEFAULT_WORKFLOW, r, "pass"); // open-a-pr
    r = advance(DEFAULT_WORKFLOW, r, "pass"); // reap
    expect(r.status).toBe("done");
    expect(projectColumn(r, DEFAULT_WORKFLOW)).toBe("complete");
  });
});

describe("gateKey", () => {
  it("formats a stable vault key per card + step", () => {
    expect(gateKey("c1", "approve-the-plan")).toBe("gate:c1:approve-the-plan");
  });
});

describe("advance — defensive", () => {
  it("advancing a done run is a no-op", () => {
    const spec = runbook();
    const done: RunState = { ...initialRunState("c1", "test"), status: "done", stepIndex: 8 };
    const next = advance(spec, done, "pass");
    expect(next).toBe(done);
  });
  it("a mismatched signal for the step kind is ignored (returns run unchanged)", () => {
    const spec = runbook();
    const r = initialRunState("c1", "test"); // at plan (prose)
    // a "pass" signal makes no sense for a prose step — ignored
    const next = advance(spec, r, "pass" as AdvanceSignal);
    expect(next.stepIndex).toBe(0);
  });
});
