import { describe, it, expect } from "vitest";
import { rangeFromOffsets, offsetsFromRange } from "../src/textOffsets";

// A node inside an iframe belongs to the iframe's document, a different realm than
// the parent. These assert rangeFromOffsets/offsetsFromRange build their Range from
// the BLOCK's own document, not the global one. (happy-dom's createHTMLDocument
// reports an inconsistent ownerDocument identity for its child nodes, so we use a
// real <iframe> contentDocument which is a faithful foreign realm.)
function foreignDoc(): Document {
  const frame = document.createElement("iframe");
  document.body.appendChild(frame);
  const doc = frame.contentDocument!;
  return doc;
}

describe("rangeFromOffsets uses the block's own document", () => {
  it("creates a Range in a foreign document, not the global one", () => {
    const otherDoc = foreignDoc();
    const p = otherDoc.createElement("p");
    p.textContent = "the quick brown fox";
    otherDoc.body.appendChild(p);
    const range = rangeFromOffsets(p, 4, 9);
    expect(range.toString()).toBe("quick");
    // The range must belong to otherDoc (parent-document range would throw/empty).
    expect(range.startContainer.ownerDocument).toBe(otherDoc);
  });

  it("offsetsFromRange works in a foreign document", () => {
    const otherDoc = foreignDoc();
    const p = otherDoc.createElement("p");
    p.textContent = "the quick brown fox";
    otherDoc.body.appendChild(p);
    const r = otherDoc.createRange();
    const tn = p.firstChild!;
    r.setStart(tn, 4); r.setEnd(tn, 9);
    expect(offsetsFromRange(p, r)).toEqual({ start: 4, end: 9 });
  });
});
