import { describe, expect, it } from "vitest";
import { markdownParser } from "../src/schema";
import { reanchorQuote } from "../src/pm-reanchor";

function parse(md: string) {
  return markdownParser.parse(md);
}

describe("reanchorQuote", () => {
  it("returns null when exact text is not found", () => {
    const doc = parse("hello world");
    const result = reanchorQuote(doc, { exact: "missing", prefix: "", suffix: "" });
    expect(result).toBeNull();
  });

  it("returns position for a unique match", () => {
    const doc = parse("hello annotated world");
    const result = reanchorQuote(doc, { exact: "annotated", prefix: "hello ", suffix: " world" });
    expect(result).toEqual({ from: 7, to: 16 });
  });

  it("returns null when context scores tie without position hint", () => {
    // "repeat repeat" — both occurrences share same context (empty prefix/suffix)
    const doc = parse("repeat repeat");
    const result = reanchorQuote(doc, { exact: "repeat", prefix: "", suffix: "" });
    expect(result).toBeNull();
  });

  it("breaks tie using position hint to pick closest occurrence", () => {
    // ProseMirror: paragraph at pos 0, text starts at pos 1
    // "repeat repeat" — first "repeat" at from=1, second at from=8
    const doc = parse("repeat repeat");
    // Position hint points to the second occurrence (start 8, end 14)
    const result = reanchorQuote(
      doc,
      { exact: "repeat", prefix: "", suffix: "" },
      { start: 8, end: 14 },
    );
    expect(result).toEqual({ from: 8, to: 14 });
  });

  it("breaks tie to closest occurrence with different context", () => {
    // "alpha beta alpha" — both "alpha" have " beta" as context, producing ties
    const doc = parse("alpha beta alpha");
    // Position hint points near the second "alpha"
    const result = reanchorQuote(
      doc,
      { exact: "alpha", prefix: "", suffix: "" },
      { start: 12, end: 17 },
    );
    expect(result).not.toBeNull();
    // Second "alpha" starts at pos 12 ("alpha beta " = 11 chars, +1 for paragraph opening)
    expect(result!.from).toBe(12);
  });

  it("still returns unique match when position hint is far away", () => {
    const doc = parse("unique annotated word");
    const result = reanchorQuote(
      doc,
      { exact: "annotated", prefix: "unique ", suffix: " word" },
      { start: 999, end: 999 },
    );
    expect(result).toEqual({ from: 8, to: 17 });
  });

  it("with position hint but no context match (exact not found) still returns null", () => {
    const doc = parse("hello world");
    const result = reanchorQuote(
      doc,
      { exact: "missing", prefix: "", suffix: "" },
      { start: 0, end: 7 },
    );
    expect(result).toBeNull();
  });

  // A selection dragged from a paragraph into a following code block is captured
  // by addAnnotation as doc.textBetween(from, to) — which concatenates the two
  // blocks' text with no separator ("…stats:dbExecute(…"). On reload this quote
  // lives in no single textblock, so a per-block search orphans it. The resolver
  // must span block boundaries the same way capture did.
  it("re-anchors a quote spanning a paragraph and a following code block", () => {
    const doc = parse("alpha\n\n```\nbeta\n```");
    // "alpha" (paragraph) + "beta" (code block) concatenate to "alphabeta";
    // "phabe" straddles the boundary (a|b).
    const exact = "phabe";
    const result = reanchorQuote(doc, { exact, prefix: "al", suffix: "ta" });
    expect(result).not.toBeNull();
    expect(doc.textBetween(result!.from, result!.to)).toBe(exact);
  });

  it("still orphans a cross-block quote whose text is genuinely absent", () => {
    const doc = parse("alpha\n\n```\nbeta\n```");
    const result = reanchorQuote(doc, { exact: "phaXXbe", prefix: "", suffix: "" });
    expect(result).toBeNull();
  });
});
