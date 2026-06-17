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
    expect([...wf.STAGE_ROLES]).toContain("terminal");
    expect(wf.isAction("merge")).toBe(true);
  });
});
