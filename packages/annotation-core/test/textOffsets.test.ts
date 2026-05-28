import { describe, it, expect } from "vitest";
import { rangeFromOffsets, offsetsFromRange } from "../src/textOffsets";

function block(html: string): Element {
  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.appendChild(root);
  return root.firstElementChild!;
}

describe("text offsets", () => {
  it("maps offsets to a range and back", () => {
    const p = block("<p>the quick brown fox</p>");
    const range = rangeFromOffsets(p, 4, 9); // "quick"
    expect(range.toString()).toBe("quick");
    expect(offsetsFromRange(p, range)).toEqual({ start: 4, end: 9 });
  });

  it("handles offsets that span multiple text nodes", () => {
    const p = block("<p>the <em>quick</em> brown fox</p>");
    const range = rangeFromOffsets(p, 4, 15); // "quick brown"
    expect(range.toString()).toBe("quick brown");
  });
});
