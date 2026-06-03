import { describe, it, expect } from "vitest";
import { assignBlockIds } from "@orden/annotation-core";
import type { OrdenAnnotation } from "@orden/annotation-core";
import { resolveAnnotationRanges, ensureHighlightStyles } from "../src/textOverlay";

function rendered(html: string): Element {
  const root = document.createElement("div");
  root.innerHTML = html; document.body.innerHTML = ""; document.body.appendChild(root);
  assignBlockIds(root); return root;
}
const ann = (exact: string): OrdenAnnotation => ({
  id: "a1", created: "t", creator: { kind: "human", id: "me" },
  target: { source: { kind: "file", vaultPath: "a", contentHash: "h" },
            selector: { type: "text-quote", exact, prefix: "", suffix: "" } },
  body: { text: "n" }, "orden:status": "open", "orden:audience": "agent", "orden:thread": [],
});

describe("resolveAnnotationRanges", () => {
  it("returns a {id, range} for each resolvable annotation", () => {
    const root = rendered("<section><p>the quick brown fox</p></section>");
    const out = resolveAnnotationRanges([ann("quick")], root);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("a1");
    expect(out[0].range.toString()).toBe("quick");
  });
  it("skips annotations that don't resolve (orphans)", () => {
    const root = rendered("<section><p>the quick brown fox</p></section>");
    expect(resolveAnnotationRanges([ann("ZZZ")], root)).toHaveLength(0);
  });
});

describe("ensureHighlightStyles", () => {
  it("injects exactly one style element even when called twice", () => {
    const doc = document.implementation.createHTMLDocument("iframe");
    ensureHighlightStyles(doc);
    ensureHighlightStyles(doc);
    const styles = doc.head.querySelectorAll("style[data-orden-highlights]");
    expect(styles).toHaveLength(1);
    expect(styles[0].textContent).toContain("::highlight(orden-annotation)");
  });
});
