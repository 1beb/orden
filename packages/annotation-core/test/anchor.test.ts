import { describe, it, expect } from "vitest";
import { assignBlockIds } from "../src/blockId";
import { rangeFromOffsets } from "../src/textOffsets";
import { createAnchor, resolveAnchor } from "../src/anchor";

function rendered(html: string): Element {
  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.innerHTML = "";
  document.body.appendChild(root);
  assignBlockIds(root);
  return root;
}

describe("createAnchor", () => {
  it("captures block id, quote, and position", () => {
    const root = rendered("<section><p>the quick brown fox jumps</p></section>");
    const p = root.querySelector("p")!;
    const range = rangeFromOffsets(p, 4, 9); // "quick"

    const anchor = createAnchor(range, root);

    expect(anchor.blockId).toBe(p.getAttribute("data-orden-block-id"));
    expect(anchor.quote!.exact).toBe("quick");
    expect(anchor.quote!.prefix.endsWith("the ")).toBe(true);
    expect(anchor.quote!.suffix.startsWith(" brown")).toBe(true);
    expect(anchor.position).toEqual({ start: 4, end: 9 });
  });
});

describe("resolveAnchor", () => {
  it("round-trips a selection back to the same text", () => {
    const root = rendered("<section><p>the quick brown fox jumps</p></section>");
    const p = root.querySelector("p")!;
    const range = rangeFromOffsets(p, 4, 9);
    const anchor = createAnchor(range, root);

    const resolved = resolveAnchor(anchor, root);
    expect(resolved).not.toBeNull();
    expect(resolved!.toString()).toBe("quick");
  });
});
