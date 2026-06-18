import { describe, it, expect } from "vitest";
import { parseWorkflowMarkdown } from "../src/parse";

const SRC = `---
name: Code (PR)
extends: default
---

## Planning

Write a plan and let me approve it.

## Complete

Push and open a PR.
`;

describe("parseWorkflowMarkdown", () => {
  it("reads frontmatter and ordered stages with prose", () => {
    const p = parseWorkflowMarkdown(SRC);
    expect(p.name).toBe("Code (PR)");
    expect(p.extends).toBe("default");
    expect(p.stages).toEqual([
      { label: "Planning", prose: "Write a plan and let me approve it." },
      { label: "Complete", prose: "Push and open a PR." },
    ]);
  });

  it("tolerates a missing frontmatter block", () => {
    const p = parseWorkflowMarkdown("## Only\n\nDo a thing.\n");
    expect(p.name).toBeUndefined();
    expect(p.extends).toBeUndefined();
    expect(p.stages).toEqual([{ label: "Only", prose: "Do a thing." }]);
  });

  it("joins multi-paragraph prose and ignores text before the first heading", () => {
    const src = "Intro blurb.\n\n## Work\n\nLine one.\n\nLine two.\n";
    const p = parseWorkflowMarkdown(src);
    expect(p.stages).toEqual([{ label: "Work", prose: "Line one.\n\nLine two." }]);
  });

  it("returns no stages for an empty doc", () => {
    expect(parseWorkflowMarkdown("").stages).toEqual([]);
  });

  const RUNBOOK_SRC = `---
name: my-flow
description: A test flow.
---

1. prose — Plan
   Write a short plan and park it.

2. gate: approve — Approve the plan
   I review and approve.

3. do: push — Publish
   Push the branch.
`;

  it("parses the numbered runbook format with typed step kinds", () => {
    const p = parseWorkflowMarkdown(RUNBOOK_SRC);
    expect(p.name).toBe("my-flow");
    expect(p.description).toBe("A test flow.");
    expect(p.stages).toEqual([
      { label: "Plan", prose: "Write a short plan and park it.", kind: "prose" },
      { label: "Approve the plan", prose: "I review and approve.", kind: "gate", gate: "approve" },
      { label: "Publish", prose: "Push the branch.", kind: "primitive", action: "push" },
    ]);
  });

  it("treats a plain dash as the label separator in the runbook format", () => {
    const p = parseWorkflowMarkdown("---\nname: t\n---\n\n1. do: check - Tests\n   run tests\n");
    expect(p.stages[0]).toEqual({ label: "Tests", prose: "run tests", kind: "primitive", action: "check" });
  });
});
