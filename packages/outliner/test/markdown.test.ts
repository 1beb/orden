import { describe, it, expect } from "vitest";
import { toMarkdown, fromMarkdown } from "../src/markdown";
import { createRoot, createBlock } from "../src/blockTree";

describe("toMarkdown", () => {
  it("renders top-level bullets", () => {
    const root = createRoot([
      createBlock("a", "first"),
      createBlock("b", "second"),
    ]);
    expect(toMarkdown(root)).toBe("- first\n- second");
  });

  it("indents children by two spaces per level", () => {
    const root = createRoot([createBlock("a", "parent")]);
    const child = createBlock("k", "child");
    child.children.push(createBlock("g", "grandchild"));
    root.children[0].children.push(child);
    expect(toMarkdown(root)).toBe(
      "- parent\n  - child\n    - grandchild",
    );
  });

  it("marks collapsed blocks with a trailing comment marker", () => {
    const root = createRoot([createBlock("a", "parent")]);
    root.children[0].collapsed = true;
    root.children[0].children.push(createBlock("k", "kid"));
    // collapsed marker is round-trippable but unobtrusive
    expect(toMarkdown(root)).toContain("collapsed:: true");
  });
});

describe("fromMarkdown", () => {
  it("parses flat bullets", () => {
    const root = fromMarkdown("- one\n- two");
    expect(root.children.map((c) => c.text)).toEqual(["one", "two"]);
  });

  it("parses nesting from indentation", () => {
    const root = fromMarkdown("- parent\n  - child\n    - grand");
    expect(root.children[0].text).toBe("parent");
    expect(root.children[0].children[0].text).toBe("child");
    expect(root.children[0].children[0].children[0].text).toBe("grand");
  });

  it("supports asterisk bullets too", () => {
    const root = fromMarkdown("* a\n* b");
    expect(root.children.map((c) => c.text)).toEqual(["a", "b"]);
  });

  it("ignores blank lines", () => {
    const root = fromMarkdown("- a\n\n- b\n");
    expect(root.children.map((c) => c.text)).toEqual(["a", "b"]);
  });

  it("restores the collapsed flag from the marker", () => {
    const md = "- parent collapsed:: true\n  - kid";
    const root = fromMarkdown(md);
    expect(root.children[0].collapsed).toBe(true);
    expect(root.children[0].text).toBe("parent");
  });
});

describe("round-trip", () => {
  it("toMarkdown -> fromMarkdown preserves text and structure", () => {
    const md = [
      "- top one",
      "  - nested a",
      "  - nested b",
      "    - deep",
      "- top two",
    ].join("\n");
    const root = fromMarkdown(md);
    expect(toMarkdown(root)).toBe(md);
  });

  it("preserves collapsed state across a round-trip", () => {
    const root = createRoot([createBlock("a", "parent")]);
    root.children[0].collapsed = true;
    root.children[0].children.push(createBlock("k", "kid"));
    const md = toMarkdown(root);
    const back = fromMarkdown(md);
    expect(back.children[0].collapsed).toBe(true);
    expect(back.children[0].text).toBe("parent");
    expect(back.children[0].children[0].text).toBe("kid");
  });
});
