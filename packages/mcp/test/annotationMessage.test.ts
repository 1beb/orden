import { describe, it, expect } from "vitest";
import { renderSingle, renderBatch, type DeliverableAnnotation } from "../src/annotationMessage";

const a = (over: Partial<DeliverableAnnotation>): DeliverableAnnotation => ({
  id: "an1",
  planDoc: "docs/plans/X.md",
  note: "do the thing",
  ...over,
});

describe("renderSingle", () => {
  it("renders a quote, note, and the reply footer", () => {
    const out = renderSingle(a({ quote: "the exact text" }));
    expect(out).toBe(
      `[orden annotation on docs/plans/X.md]\n` +
        `> "the exact text"\n` +
        `do the thing\n` +
        `(annotation an1 — reply in-thread or resolve when addressed)`,
    );
  });

  it("falls back to a block reference when there is no quote", () => {
    const out = renderSingle(a({ blockId: "blk7" }));
    expect(out).toBe(
      `[orden annotation on docs/plans/X.md]\n` +
        `(see annotation an1 at block blk7)\n` +
        `do the thing\n` +
        `(annotation an1 — reply in-thread or resolve when addressed)`,
    );
  });

  it("omits the block clause when there is neither quote nor blockId", () => {
    const out = renderSingle(a({}));
    expect(out).toContain(`(see annotation an1)\n`);
    expect(out).not.toContain("at block");
  });
});

describe("renderBatch", () => {
  it("numbers items and indents the note under each", () => {
    const out = renderBatch("docs/plans/X.md", [
      a({ id: "a1", quote: "first quote", note: "first note" }),
      a({ id: "a2", quote: "second quote", note: "second note" }),
    ]);
    expect(out).toBe(
      `[orden — 2 annotations on docs/plans/X.md]\n` +
        `1. > "first quote"\n` +
        `   first note\n` +
        `2. > "second quote"\n` +
        `   second note`,
    );
  });

  it("applies the quote fallback per item in a mixed batch", () => {
    const out = renderBatch("docs/plans/X.md", [
      a({ id: "a1", quote: "has quote", note: "n1" }),
      a({ id: "a2", blockId: "b2", note: "n2" }),
      a({ id: "a3", note: "n3" }),
    ]);
    expect(out).toBe(
      `[orden — 3 annotations on docs/plans/X.md]\n` +
        `1. > "has quote"\n` +
        `   n1\n` +
        `2. (see annotation a2 at block b2)\n` +
        `   n2\n` +
        `3. (see annotation a3)\n` +
        `   n3`,
    );
  });
});
