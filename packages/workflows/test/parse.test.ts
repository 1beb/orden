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
});
