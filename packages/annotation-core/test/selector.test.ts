import { describe, it, expect } from "vitest";
import { assignBlockIds, BLOCK_ID_ATTR } from "../src/blockId";
import type { Selector } from "../src/wadm";
import { resolveSelectors } from "../src/selector";

function rendered(html: string): Element {
  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.innerHTML = "";
  document.body.appendChild(root);
  assignBlockIds(root);
  return root;
}

describe("resolveSelectors", () => {
  it("resolves a text-quote selector", () => {
    const root = rendered("<section><p>the quick brown fox</p></section>");
    const sel: Selector = { type: "text-quote", exact: "quick", prefix: "the ", suffix: " brown" };
    const range = resolveSelectors(sel, root);
    expect(range).not.toBeNull();
    expect(range!.toString()).toBe("quick");
  });

  it("falls back to text-position when quote fails", () => {
    const root = rendered("<section><p>the quick brown fox</p></section>");
    const blockId = root.querySelector("p")!.getAttribute(BLOCK_ID_ATTR)!;
    const selectors: Selector[] = [
      { type: "text-quote", exact: "ZZZ-gone", prefix: "", suffix: "" },
      { type: "text-position", start: 4, end: 9, blockId },
    ];
    const range = resolveSelectors(selectors, root);
    expect(range).not.toBeNull();
    expect(range!.toString()).toBe("quick");
  });

  it("returns null for a region selector (no DOM range)", () => {
    const root = rendered("<section><p>x</p></section>");
    const sel: Selector = { type: "region", rect: { x: 0, y: 0, w: 1, h: 1 } };
    expect(resolveSelectors(sel, root)).toBeNull();
  });

  it("returns null when nothing resolves", () => {
    const root = rendered("<section><p>the quick brown fox</p></section>");
    const sel: Selector = { type: "text-quote", exact: "nope", prefix: "", suffix: "" };
    expect(resolveSelectors(sel, root)).toBeNull();
  });
});
