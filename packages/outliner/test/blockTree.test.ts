import { describe, it, expect, beforeEach } from "vitest";
import {
  createBlock,
  createRoot,
  indent,
  outdent,
  moveUp,
  moveDown,
  splitBlock,
  mergeWithPrevious,
  toggleCollapse,
  findBlock,
} from "../src/blockTree";
import type { Block } from "../src/types";

/** Build a small tree:
 *   - a
 *   - b
 *   - c
 */
function flatTree(): Block {
  return createRoot([
    createBlock("a", "a"),
    createBlock("b", "b"),
    createBlock("c", "c"),
  ]);
}

describe("createBlock / createRoot", () => {
  it("creates a block with defaults", () => {
    const b = createBlock("x", "hello");
    expect(b.id).toBe("x");
    expect(b.text).toBe("hello");
    expect(b.collapsed).toBe(false);
    expect(b.children).toEqual([]);
  });

  it("auto-generates unique ids when none given", () => {
    const b1 = createBlock(undefined, "one");
    const b2 = createBlock(undefined, "two");
    expect(b1.id).not.toBe(b2.id);
    expect(b1.id).toBeTruthy();
  });
});

describe("indent", () => {
  it("makes a block a child of its previous sibling", () => {
    const root = flatTree();
    indent(root, "b");
    expect(root.children.map((c) => c.id)).toEqual(["a", "c"]);
    const a = findBlock(root, "a")!;
    expect(a.children.map((c) => c.id)).toEqual(["b"]);
  });

  it("does nothing for the first sibling (no previous to nest under)", () => {
    const root = flatTree();
    const before = JSON.stringify(root);
    indent(root, "a");
    expect(JSON.stringify(root)).toBe(before);
  });

  it("appends to the end of the previous sibling's children", () => {
    const root = createRoot([
      createBlock("a", "a"),
      createBlock("b", "b"),
    ]);
    indent(root, "a"); // no-op (first)
    // Make a have an existing child, then indent b under a.
    findBlock(root, "a")!.children.push(createBlock("a1", "a1"));
    indent(root, "b");
    expect(findBlock(root, "a")!.children.map((c) => c.id)).toEqual(["a1", "b"]);
  });
});

describe("outdent", () => {
  it("promotes a nested block to a sibling of its parent", () => {
    const root = flatTree();
    indent(root, "b"); // b under a
    outdent(root, "b");
    expect(root.children.map((c) => c.id)).toEqual(["a", "b", "c"]);
  });

  it("inserts the outdented block directly after its old parent", () => {
    const root = createRoot([createBlock("a", "a"), createBlock("z", "z")]);
    findBlock(root, "a")!.children.push(createBlock("b", "b"));
    findBlock(root, "a")!.children.push(createBlock("c", "c"));
    outdent(root, "b");
    // b moves out after a, before z; c stays under a
    expect(root.children.map((c) => c.id)).toEqual(["a", "b", "z"]);
    expect(findBlock(root, "a")!.children.map((c) => c.id)).toEqual(["c"]);
  });

  it("does nothing for a top-level block (no parent to escape)", () => {
    const root = flatTree();
    const before = JSON.stringify(root);
    outdent(root, "a");
    expect(JSON.stringify(root)).toBe(before);
  });
});

describe("moveUp / moveDown", () => {
  it("moveUp swaps with previous sibling", () => {
    const root = flatTree();
    moveUp(root, "b");
    expect(root.children.map((c) => c.id)).toEqual(["b", "a", "c"]);
  });

  it("moveUp on first sibling is a no-op", () => {
    const root = flatTree();
    moveUp(root, "a");
    expect(root.children.map((c) => c.id)).toEqual(["a", "b", "c"]);
  });

  it("moveDown swaps with next sibling", () => {
    const root = flatTree();
    moveDown(root, "b");
    expect(root.children.map((c) => c.id)).toEqual(["a", "c", "b"]);
  });

  it("moveDown on last sibling is a no-op", () => {
    const root = flatTree();
    moveDown(root, "c");
    expect(root.children.map((c) => c.id)).toEqual(["a", "b", "c"]);
  });
});

describe("splitBlock (Enter)", () => {
  it("splits text at the offset into a new sibling after the block", () => {
    const root = createRoot([createBlock("a", "hello world")]);
    const newId = splitBlock(root, "a", 5);
    expect(root.children.map((c) => c.id)).toEqual(["a", newId]);
    expect(findBlock(root, "a")!.text).toBe("hello");
    expect(findBlock(root, newId)!.text).toBe(" world");
  });

  it("new block inherits children of the original", () => {
    const root = createRoot([createBlock("a", "parenttext")]);
    findBlock(root, "a")!.children.push(createBlock("kid", "kid"));
    const newId = splitBlock(root, "a", 6);
    expect(findBlock(root, "a")!.children).toEqual([]);
    expect(findBlock(root, newId)!.children.map((c) => c.id)).toEqual(["kid"]);
  });

  it("splitting at end creates an empty new block", () => {
    const root = createRoot([createBlock("a", "abc")]);
    const newId = splitBlock(root, "a", 3);
    expect(findBlock(root, newId)!.text).toBe("");
  });
});

describe("mergeWithPrevious (Backspace at start)", () => {
  it("merges a block's text into the end of its previous sibling", () => {
    const root = createRoot([
      createBlock("a", "foo"),
      createBlock("b", "bar"),
    ]);
    const target = mergeWithPrevious(root, "b");
    expect(target).toBe("a");
    expect(root.children.map((c) => c.id)).toEqual(["a"]);
    expect(findBlock(root, "a")!.text).toBe("foobar");
  });

  it("moves the merged block's children onto the previous sibling", () => {
    const root = createRoot([
      createBlock("a", "foo"),
      createBlock("b", "bar"),
    ]);
    findBlock(root, "b")!.children.push(createBlock("k", "k"));
    mergeWithPrevious(root, "b");
    expect(findBlock(root, "a")!.children.map((c) => c.id)).toEqual(["k"]);
  });

  it("returns null and does nothing for the first sibling", () => {
    const root = flatTree();
    const r = mergeWithPrevious(root, "a");
    expect(r).toBeNull();
    expect(root.children.map((c) => c.id)).toEqual(["a", "b", "c"]);
  });
});

describe("toggleCollapse", () => {
  it("flips the collapsed flag", () => {
    const root = createRoot([createBlock("a", "a")]);
    expect(findBlock(root, "a")!.collapsed).toBe(false);
    toggleCollapse(root, "a");
    expect(findBlock(root, "a")!.collapsed).toBe(true);
    toggleCollapse(root, "a");
    expect(findBlock(root, "a")!.collapsed).toBe(false);
  });
});

describe("findBlock", () => {
  let root: Block;
  beforeEach(() => {
    root = flatTree();
    indent(root, "b");
  });
  it("finds nested blocks", () => {
    expect(findBlock(root, "b")?.text).toBe("b");
  });
  it("returns null for missing ids", () => {
    expect(findBlock(root, "nope")).toBeNull();
  });
});
