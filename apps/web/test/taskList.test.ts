import { describe, expect, it } from "vitest";
import { EditorState } from "prosemirror-state";
import { schema, markdownParser } from "../src/schema";
import { toggleTaskAt } from "../src/taskList";

function stateFrom(md: string) {
  return EditorState.create({ doc: markdownParser.parse(md), schema });
}

function firstItemPos(doc: import("prosemirror-model").Node) {
  let pos = -1;
  doc.descendants((n, p) => {
    if (pos < 0 && n.type.name === "list_item") pos = p;
  });
  return pos;
}

function firstItemChecked(doc: import("prosemirror-model").Node) {
  let checked: boolean | null | undefined;
  doc.descendants((n) => {
    if (checked === undefined && n.type.name === "list_item") checked = n.attrs.checked;
  });
  return checked;
}

describe("toggleTaskAt", () => {
  it("flips an unchecked task item to checked", () => {
    const state = stateFrom("- [ ] todo");
    const tr = toggleTaskAt(state, firstItemPos(state.doc) + 1);
    expect(tr).not.toBeNull();
    expect(firstItemChecked(tr!.doc)).toBe(true);
  });

  it("flips a checked task item back to unchecked", () => {
    const state = stateFrom("- [x] done");
    const tr = toggleTaskAt(state, firstItemPos(state.doc) + 1);
    expect(firstItemChecked(tr!.doc)).toBe(false);
  });

  it("returns null for a non-task bullet item", () => {
    const state = stateFrom("- plain");
    expect(toggleTaskAt(state, firstItemPos(state.doc) + 1)).toBeNull();
  });
});
