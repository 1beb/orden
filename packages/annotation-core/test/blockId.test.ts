import { describe, it, expect } from "vitest";
import { computeBlockId } from "../src/blockId";
import { assignBlockIds, BLOCK_ID_ATTR } from "../src/blockId";

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

describe("assignBlockIds", () => {
  it("stamps an id on every block-level element", () => {
    const root = document.createElement("div");
    root.innerHTML = "<h1>Title</h1><p>one</p><ul><li>a</li><li>b</li></ul>";
    assignBlockIds(root);
    const stamped = root.querySelectorAll(`[${BLOCK_ID_ATTR}]`);
    expect(stamped.length).toBe(5); // h1, p, ul, li, li
  });

  it("is idempotent", () => {
    const root = document.createElement("div");
    root.innerHTML = "<p>one</p>";
    assignBlockIds(root);
    const first = root.querySelector("p")!.getAttribute(BLOCK_ID_ATTR);
    assignBlockIds(root);
    const second = root.querySelector("p")!.getAttribute(BLOCK_ID_ATTR);
    expect(second).toBe(first);
  });
});
