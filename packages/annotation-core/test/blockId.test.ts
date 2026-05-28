import { describe, it, expect } from "vitest";
import { computeBlockId } from "../src/blockId";

function blockAt(html: string, selector: string): Element {
  const root = document.createElement("div");
  root.innerHTML = html;
  return root.querySelector(selector)!;
}

describe("computeBlockId", () => {
  it("is stable for the same block across calls", () => {
    const html = "<section><p>alpha</p><p>beta</p></section>";
    const a = computeBlockId(blockAt(html, "p:nth-child(2)"));
    const b = computeBlockId(blockAt(html, "p:nth-child(2)"));
    expect(a).toBe(b);
  });

  it("differs for different content", () => {
    const html = "<section><p>alpha</p><p>beta</p></section>";
    const first = computeBlockId(blockAt(html, "p:nth-child(1)"));
    const second = computeBlockId(blockAt(html, "p:nth-child(2)"));
    expect(first).not.toBe(second);
  });

  it("differs for the same text at a different structural path", () => {
    const a = computeBlockId(blockAt("<section><p>same</p></section>", "p"));
    const b = computeBlockId(blockAt("<article><p>same</p></article>", "p"));
    expect(a).not.toBe(b);
  });
});
