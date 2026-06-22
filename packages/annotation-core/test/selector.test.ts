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

  // A selection that starts in one stamped block and ends in another (e.g. a
  // paragraph dragged into a following code block) captures `range.toString()`,
  // which concatenates text across the block boundary with no separator. The
  // per-block resolver can't find that string in any single block, so it must
  // fall back to a document-wide search or the annotation orphans on re-render.
  it("resolves a quote that spans two blocks", () => {
    const root = rendered(
      "<section><p>via manifest stats:</p><pre><code>dbExecute(con, x)</code></pre></section>",
    );
    const sel: Selector = {
      type: "text-quote",
      exact: "stats:dbExecute(con, x)",
      prefix: "",
      suffix: "",
    };
    const range = resolveSelectors(sel, root);
    expect(range).not.toBeNull();
    expect(range!.toString()).toBe("stats:dbExecute(con, x)");
  });

  // A triple-clicked heading captures "Title\n" — the trailing newline has no
  // counterpart in the <h2>'s textContent, nor anywhere if the render has no
  // inter-block whitespace text node — so the raw quote orphans. The resolver
  // must fall back to the trimmed quote and anchor on the real content.
  it("resolves a quote with a trailing newline when no whitespace node follows", () => {
    const root = rendered("<section><h2>Executive Summary</h2><p>Body text.</p></section>");
    const sel: Selector = {
      type: "text-quote",
      exact: "Executive Summary\n",
      prefix: "",
      suffix: "",
    };
    const range = resolveSelectors(sel, root);
    expect(range).not.toBeNull();
    expect(range!.toString()).toBe("Executive Summary");
  });

  it("resolves a quote with leading/trailing whitespace", () => {
    const root = rendered("<section><p>alpha beta gamma</p></section>");
    const sel: Selector = { type: "text-quote", exact: "  beta \n", prefix: "", suffix: "" };
    const range = resolveSelectors(sel, root);
    expect(range).not.toBeNull();
    expect(range!.toString()).toBe("beta");
  });
});
