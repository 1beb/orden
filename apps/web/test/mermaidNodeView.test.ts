import { describe, expect, it } from "vitest";
import { schema, markdownParser, markdownSerializer } from "../src/schema";
import { isMermaidBlock, buildMermaidDom } from "../src/mermaidNodeView";

function codeBlock(params: string, text: string) {
  return schema.nodes.code_block.create({ params }, text ? schema.text(text) : null);
}

describe("mermaid blocks", () => {
  it("detects a ```mermaid code block", () => {
    expect(isMermaidBlock(codeBlock("mermaid", "graph TD; A-->B"))).toBe(true);
  });

  it("ignores non-mermaid code blocks and plain fences", () => {
    expect(isMermaidBlock(codeBlock("js", "x"))).toBe(false);
    expect(isMermaidBlock(codeBlock("", "x"))).toBe(false);
  });

  it("round-trips a mermaid fence unchanged", () => {
    const md = "```mermaid\ngraph TD; A-->B\n```";
    const out = markdownSerializer.serialize(markdownParser.parse(md)).trim();
    expect(out).toBe(md);
  });

  it("builds a scaffold with an editable source element and a render target", () => {
    const { dom, contentDOM, preview } = buildMermaidDom();
    expect(dom.classList.contains("mermaid-block")).toBe(true);
    expect(contentDOM.tagName).toBe("CODE");
    expect(preview.classList.contains("mermaid-render")).toBe(true);
    expect(dom.contains(contentDOM)).toBe(true);
    expect(dom.contains(preview)).toBe(true);
    // The render target must not be editable (it's generated, not source).
    expect(preview.getAttribute("contenteditable")).toBe("false");
  });
});
