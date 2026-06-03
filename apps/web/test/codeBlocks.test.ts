import { describe, it, expect } from "vitest";
import { BLOCK_ID_ATTR, resolveSelectors } from "@orden/annotation-core";
import { renderCodeView, assignCodeBlockIds } from "../src/codeView";
import { selectorsForRange } from "../src/textSelector";

// Collect text nodes recursively. happy-dom's TreeWalker(SHOW_TEXT) skips text
// nodes that sit beside inline elements (e.g. hljs token <span>s), so a manual
// recursion is required to reach the .code-src text node holding the needle.
function textNodes(node: Node, out: Text[] = []): Text[] {
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) out.push(child as Text);
    else textNodes(child, out);
  }
  return out;
}

function rangeOverText(el: Element, needle: string): Range {
  // find the text node under el containing needle, build a range over it
  for (const n of textNodes(el)) {
    const i = (n.textContent ?? "").indexOf(needle);
    if (i >= 0) {
      const r = document.createRange();
      r.setStart(n, i);
      r.setEnd(n, i + needle.length);
      return r;
    }
  }
  throw new Error("needle not found: " + needle);
}

describe("assignCodeBlockIds", () => {
  it("tags only .code-src, excludes gutter line-numbers from anchor text", () => {
    const host = document.createElement("div");
    document.body.replaceChildren(host);
    const root = renderCodeView(host, {
      title: "x",
      path: "a.ts",
      content: "const alpha = 1;\nconst beta = 2;",
    });
    assignCodeBlockIds(root);
    const srcs = root.querySelectorAll(`.code-src[${BLOCK_ID_ATTR}]`);
    expect(srcs.length).toBe(2); // one per line
    // No gutter/pre/line-div got tagged:
    expect(root.querySelectorAll(`.code-gutter[${BLOCK_ID_ATTR}]`).length).toBe(0);
    expect(root.querySelectorAll(`pre[${BLOCK_ID_ATTR}]`).length).toBe(0);
    expect(root.querySelectorAll(`.code-line[${BLOCK_ID_ATTR}]`).length).toBe(0);
  });

  it("selection over code resolves round-trip (no gutter contamination)", () => {
    const host = document.createElement("div");
    document.body.replaceChildren(host);
    const root = renderCodeView(host, {
      title: "x",
      path: "a.ts",
      content: "const alpha = 1;\nconst beta = 2;",
    });
    assignCodeBlockIds(root);
    const range = rangeOverText(root, "beta");
    const sels = selectorsForRange(range);
    const resolved = resolveSelectors(sels, root);
    expect(resolved).not.toBeNull();
    expect(resolved!.toString()).toBe("beta");
  });
});
