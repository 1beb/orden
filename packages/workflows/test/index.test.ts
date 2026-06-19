import { describe, it, expect } from "vitest";
import * as wf from "../src/index";

describe("public surface", () => {
  it("exposes the model, catalog, default, parser, validator, and resolver", () => {
    expect(typeof wf.parseWorkflowMarkdown).toBe("function");
    expect(typeof wf.validateWorkflow).toBe("function");
    expect(typeof wf.resolveSpec).toBe("function");
    expect(wf.DEFAULT_WORKFLOW.name).toBe("default");
    expect([...wf.ACTIONS]).toContain("verify");
    expect([...wf.GATES]).toContain("approve");
    expect([...wf.ROLES]).toContain("terminal");
    expect(wf.isAction("merge")).toBe(true);
  });

  it("exposes the lifecycle vocabulary (Lane/Role + default config)", () => {
    expect(wf.DEFAULT_LIFECYCLE.order).toContain("on-hold");
    expect(wf.DEFAULT_LIFECYCLE.lanes["on-hold"].manual).toBe(true);
    expect(wf.DEFAULT_LIFECYCLE.lanes["on-hold"].role).toBeUndefined();
    // on-hold is furled by default and non-automatic (manual park).
    expect(wf.DEFAULT_LIFECYCLE.furledByDefault).toContain("on-hold");
    expect(wf.DEFAULT_LIFECYCLE.nonAutomatic).toContain("on-hold");
    // the four role lanes map onto a Role each.
    expect(wf.DEFAULT_LIFECYCLE.lanes["planning"].role).toBe("initial");
    expect(wf.DEFAULT_LIFECYCLE.lanes["complete"].role).toBe("terminal");
  });
});
