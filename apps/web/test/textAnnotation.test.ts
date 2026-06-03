import { describe, it, expect } from "vitest";
import { assignBlockIds, type Source } from "@orden/annotation-core";
import { buildTextAnnotation } from "../src/textAnnotation";

const source: Source = {
  kind: "file",
  id: "repo:a.ts",
  hash: "h",
} as unknown as Source;

function pWithText(text: string): HTMLElement {
  const host = document.createElement("div");
  const p = document.createElement("p");
  p.textContent = text;
  host.append(p);
  document.body.replaceChildren(host);
  assignBlockIds(host);
  return host;
}

function rangeOverWord(root: Element, word: string): Range {
  const p = root.querySelector("p")!;
  const node = p.firstChild!; // text node
  const i = (node.textContent ?? "").indexOf(word);
  const r = document.createRange();
  r.setStart(node, i);
  r.setEnd(node, i + word.length);
  return r;
}

describe("buildTextAnnotation", () => {
  it("composes selection + source + note into an OrdenAnnotation", () => {
    const root = pWithText("the quick brown fox");
    const range = rangeOverWord(root, "quick");
    const ann = buildTextAnnotation({
      source,
      range,
      root,
      note: "  a note  ",
      creator: { kind: "human", id: "brandon" },
    });
    expect(ann).not.toBeNull();
    expect(ann!.body.text).toBe("  a note  ");
    expect(Array.isArray(ann!.target.selector)).toBe(true);
    const sels = ann!.target.selector as unknown[];
    expect(sels.length).toBe(2); // [text-quote, text-position]
    expect(ann!["orden:status"]).toBe("open");
    expect(ann!.creator).toEqual({ kind: "human", id: "brandon" });
    expect(ann!["orden:audience"]).toBe("agent"); // default
  });

  it("respects an explicit audience", () => {
    const root = pWithText("the quick brown fox");
    const range = rangeOverWord(root, "brown");
    const ann = buildTextAnnotation({
      source,
      range,
      root,
      note: "x",
      creator: { kind: "agent", id: "claude" },
      audience: "human",
    });
    expect(ann!["orden:audience"]).toBe("human");
  });

  it("returns null for a collapsed range (no selectors)", () => {
    const root = pWithText("the quick brown fox");
    const p = root.querySelector("p")!;
    const range = document.createRange();
    range.setStart(p.firstChild!, 3);
    range.collapse(true);
    const ann = buildTextAnnotation({
      source,
      range,
      root,
      note: "x",
      creator: { kind: "human", id: "brandon" },
    });
    expect(ann).toBeNull();
  });
});
