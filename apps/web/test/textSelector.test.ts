import { describe, it, expect } from "vitest";
import { assignBlockIds, BLOCK_ID_ATTR, resolveSelectors } from "@orden/annotation-core";
import { selectorsForRange } from "../src/textSelector";

function rendered(html: string): Element {
  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.innerHTML = "";
  document.body.appendChild(root);
  assignBlockIds(root);
  return root;
}

describe("selectorsForRange", () => {
  it("emits a text-quote + text-position fallback for a selection", () => {
    const root = rendered("<section><p>the quick brown fox</p></section>");
    const p = root.querySelector("p")!;
    const range = document.createRange();
    const textNode = p.firstChild!;
    range.setStart(textNode, 4); // "quick"
    range.setEnd(textNode, 9);
    const sels = selectorsForRange(range, root);
    // Quote context is a raw 32-char window (same convention as anchor.ts), so the
    // suffix over-reaches past one word — assert a prefix-of like anchor.test.ts does.
    expect(sels[0]).toMatchObject({ type: "text-quote", exact: "quick", prefix: "the " });
    expect((sels[0] as { suffix: string }).suffix.startsWith(" brown")).toBe(true);
    expect(sels[1]).toMatchObject({ type: "text-position", start: 4, end: 9 });
    expect((sels[1] as { blockId: string }).blockId).toBe(p.getAttribute(BLOCK_ID_ATTR));
  });

  it("returns [] for a collapsed range", () => {
    const root = rendered("<section><p>abc</p></section>");
    const range = document.createRange();
    range.setStart(root.querySelector("p")!.firstChild!, 1);
    range.collapse(true);
    expect(selectorsForRange(range, root)).toEqual([]);
  });

  it("produces offsets that round-trip through resolveSelectors", () => {
    const root = rendered("<section><p>alpha <strong>beta</strong> gamma delta</p></section>");
    const p = root.querySelector("p")!;
    // Select "gamma" which lives in the trailing text node after <strong>.
    const tail = p.lastChild!; // " gamma delta"
    const range = document.createRange();
    range.setStart(tail, 1); // skip leading space -> "gamma"
    range.setEnd(tail, 6);
    expect(range.toString()).toBe("gamma");
    const sels = selectorsForRange(range, root);
    expect(sels[0]).toMatchObject({ type: "text-quote", exact: "gamma" });
    const resolved = resolveSelectors(sels, root);
    expect(resolved).not.toBeNull();
    expect(resolved!.toString()).toBe("gamma");
  });
});
