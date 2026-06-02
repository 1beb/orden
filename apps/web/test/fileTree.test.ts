import { describe, expect, it } from "vitest";
import { buildFileTree, matchesSearch, type FileTreeNode } from "../src/fileTree";

describe("matchesSearch", () => {
  it("matches everything when the query is empty or whitespace", () => {
    expect(matchesSearch("apps/web/main.ts", "")).toBe(true);
    expect(matchesSearch("apps/web/main.ts", "   ")).toBe(true);
  });

  it("matches a substring anywhere in the path, case-insensitively", () => {
    expect(matchesSearch("apps/web/src/Main.ts", "main")).toBe(true);
    expect(matchesSearch("apps/web/src/Main.ts", "WEB")).toBe(true);
    expect(matchesSearch("apps/web/src/Main.ts", "kanban")).toBe(false);
  });

  it("requires every whitespace-separated word to match (AND)", () => {
    expect(matchesSearch("apps/web/src/cards.ts", "web cards")).toBe(true);
    expect(matchesSearch("apps/web/src/cards.ts", "web kanban")).toBe(false);
    // words may match in any order and across the whole path
    expect(matchesSearch("apps/web/src/cards.ts", "cards apps")).toBe(true);
  });

  it("collapses extra whitespace between words", () => {
    expect(matchesSearch("apps/web/src/cards.ts", "  web    cards  ")).toBe(true);
  });
});

// Compact shape for readable assertions: "name" for files, "name/" for dirs
// with their children nested.
function shape(nodes: FileTreeNode[]): unknown {
  return nodes.map((n) =>
    n.isDir ? { [`${n.name}/`]: shape(n.children) } : n.name,
  );
}

describe("buildFileTree", () => {
  it("returns bare files for root-level paths, case-insensitively sorted", () => {
    const tree = buildFileTree(["readme.md", "LICENSE", "a.ts"]);
    expect(shape(tree)).toEqual(["a.ts", "LICENSE", "readme.md"]);
    expect(tree.every((n) => !n.isDir)).toBe(true);
  });

  it("nests files under their folders", () => {
    const tree = buildFileTree(["src/main.ts", "src/cards.ts", "readme.md"]);
    expect(shape(tree)).toEqual([
      { "src/": ["cards.ts", "main.ts"] },
      "readme.md",
    ]);
  });

  it("sorts directories before files within a level", () => {
    const tree = buildFileTree(["zeta.md", "alpha/x.ts"]);
    expect(shape(tree)).toEqual([{ "alpha/": ["x.ts"] }, "zeta.md"]);
  });

  it("compacts single-child folder chains into one row", () => {
    const tree = buildFileTree(["apps/web/src/main.ts", "apps/web/src/cards.ts"]);
    expect(shape(tree)).toEqual([
      { "apps/web/src/": ["cards.ts", "main.ts"] },
    ]);
  });

  it("does NOT compact a folder that also holds a file", () => {
    const tree = buildFileTree(["apps/readme.md", "apps/web/src/main.ts"]);
    expect(shape(tree)).toEqual([
      {
        "apps/": [{ "web/src/": ["main.ts"] }, "readme.md"],
      },
    ]);
  });

  it("does NOT compact a folder with two child folders", () => {
    const tree = buildFileTree(["a/x/1.ts", "a/y/2.ts"]);
    expect(shape(tree)).toEqual([
      { "a/": [{ "x/": ["1.ts"] }, { "y/": ["2.ts"] }] },
    ]);
  });

  it("carries the full path on file nodes", () => {
    const tree = buildFileTree(["apps/web/src/main.ts"]);
    const dir = tree[0];
    expect(dir.isDir).toBe(true);
    expect(dir.children[0].path).toBe("apps/web/src/main.ts");
    expect(dir.children[0].name).toBe("main.ts");
  });

  it("carries the folder path on dir nodes (for stable expand keys)", () => {
    const tree = buildFileTree(["apps/web/src/main.ts", "apps/readme.md"]);
    expect(tree[0].path).toBe("apps");
    const web = tree[0].children.find((n) => n.isDir)!;
    expect(web.path).toBe("apps/web/src");
  });
});
