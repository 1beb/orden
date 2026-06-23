import { describe, it, expect } from "vitest";
import { EditorState } from "prosemirror-state";
import { schema, markdownParser } from "../src/schema";
import { scanAnnotations } from "../src/annotations";

// An annotation over text inside a fenced code block must keep its mark. The
// markdown code_block node defaults to marks:"" (no marks), which silently drops
// the annotation mark on addMark, so the annotation orphans the instant it is
// made. code_block must allow the annotation mark.
describe("code-block annotations", () => {
  it("keeps the annotation mark on code-block text", () => {
    const doc = markdownParser.parse("```r\nscored_then <- dbGetQuery(con)\n```");
    let state = EditorState.create({ doc, schema });
    const mark = schema.marks.annotation.create({ id: "ann1", target: "agent" });
    // The code text spans the inside of the single code_block.
    state = state.apply(state.tr.addMark(1, doc.content.size - 1, mark));
    const placed = scanAnnotations(state.doc);
    expect(placed.map((p) => p.id)).toContain("ann1");
  });
});
