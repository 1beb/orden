import { describe, expect, it } from "vitest";
import { markdownParser, markdownSerializer, schema } from "../src/schema";
import type { Node as PMNode } from "prosemirror-model";

// Round-trip helper: markdown -> ProseMirror doc -> markdown.
function roundtrip(md: string): string {
  return markdownSerializer.serialize(markdownParser.parse(md)).trim();
}

// Collect the set of mark type names that appear on any text node.
function marksIn(doc: PMNode): Set<string> {
  const names = new Set<string>();
  doc.descendants((n) => {
    if (n.isText) n.marks.forEach((m) => names.add(m.type.name));
  });
  return names;
}

// Collect the set of node type names anywhere in the doc.
function nodesIn(doc: PMNode): Set<string> {
  const names = new Set<string>();
  doc.descendants((n) => names.add(n.type.name));
  return names;
}

describe("highlight mark (==text==)", () => {
  it("parses ==text== into a highlight mark", () => {
    const doc = markdownParser.parse("==important==");
    expect(marksIn(doc).has("highlight")).toBe(true);
  });

  it("round-trips ==text== back to == syntax", () => {
    expect(roundtrip("a ==big== deal")).toBe("a ==big== deal");
  });

  it("leaves plain text without markers unmarked", () => {
    const doc = markdownParser.parse("no markers here");
    expect(marksIn(doc).has("highlight")).toBe(false);
  });
});

// Pull every list_item node's `checked` attr in document order.
function listItemChecked(doc: PMNode): Array<boolean | null> {
  const out: Array<boolean | null> = [];
  doc.descendants((n) => {
    if (n.type.name === "list_item") out.push(n.attrs.checked as boolean | null);
  });
  return out;
}

describe("task list items (- [ ] / - [x])", () => {
  it("parses an unchecked item to checked=false", () => {
    const doc = markdownParser.parse("- [ ] todo");
    expect(listItemChecked(doc)).toEqual([false]);
  });

  it("parses a checked item to checked=true (case-insensitive)", () => {
    expect(listItemChecked(markdownParser.parse("- [x] done"))).toEqual([true]);
    expect(listItemChecked(markdownParser.parse("- [X] done"))).toEqual([true]);
  });

  it("strips the [ ]/[x] marker from the item text", () => {
    const doc = markdownParser.parse("- [ ] buy milk");
    let text = "";
    doc.descendants((n) => {
      if (n.isText) text += n.text;
    });
    expect(text).toBe("buy milk");
  });

  it("leaves a normal bullet item as a non-task item (checked=null)", () => {
    expect(listItemChecked(markdownParser.parse("- plain"))).toEqual([null]);
  });

  it("round-trips checkbox markers", () => {
    const out = roundtrip("- [ ] a\n- [x] b");
    expect(out).toContain("[ ] a");
    expect(out).toContain("[x] b");
  });

  it("does not emit a marker for plain items", () => {
    expect(roundtrip("- plain")).not.toContain("[ ]");
  });
});

// First admonition node's kind attr, or undefined if none.
function firstAdmonitionKind(doc: PMNode): string | undefined {
  let kind: string | undefined;
  doc.descendants((n) => {
    if (n.type.name === "admonition" && kind === undefined) kind = n.attrs.kind as string;
  });
  return kind;
}

describe("callouts / GitHub alerts (> [!NOTE])", () => {
  it("parses > [!NOTE] into an admonition node carrying the kind", () => {
    const doc = markdownParser.parse("> [!NOTE]\n> Heads up.");
    expect(nodesIn(doc).has("admonition")).toBe(true);
    expect(firstAdmonitionKind(doc)).toBe("note");
  });

  it("recognises all five GitHub alert kinds", () => {
    for (const kind of ["note", "tip", "important", "warning", "caution"]) {
      const doc = markdownParser.parse(`> [!${kind.toUpperCase()}]\n> body`);
      expect(firstAdmonitionKind(doc)).toBe(kind);
    }
  });

  it("strips the [!NOTE] marker from the body text", () => {
    const doc = markdownParser.parse("> [!WARNING]\n> Don't do that.");
    let text = "";
    doc.descendants((n) => {
      if (n.isText) text += n.text;
    });
    expect(text).toBe("Don't do that.");
  });

  it("keeps a plain blockquote as a blockquote", () => {
    const doc = markdownParser.parse("> just a quote");
    expect(nodesIn(doc).has("blockquote")).toBe(true);
    expect(nodesIn(doc).has("admonition")).toBe(false);
  });

  it("round-trips the alert marker", () => {
    const out = roundtrip("> [!TIP]\n> Useful.");
    expect(out).toContain("[!TIP]");
    expect(out).toContain("Useful.");
    // Re-parsing the serialized output yields the same admonition.
    expect(firstAdmonitionKind(markdownParser.parse(out))).toBe("tip");
  });
});
