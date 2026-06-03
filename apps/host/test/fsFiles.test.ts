import { describe, test, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { FsFiles } from "../src/fsFiles";

const dirs: string[] = [];
function root(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), "fsroot-"));
  dirs.push(d);
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(d, p)), { recursive: true });
    writeFileSync(join(d, p), c);
  }
  return d;
}
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

describe("FsFiles (multi-root)", () => {
  test("lists files from the resolved per-project root", async () => {
    const a = root({ "a.md": "# A" });
    const b = root({ "b.md": "# B" });
    const fs = new FsFiles(async (id) => (id === "pa" ? a : id === "pb" ? b : undefined));
    expect((await fs.list("pa")).map((e) => e.path)).toEqual(["a.md"]);
    expect((await fs.list("pb")).map((e) => e.path)).toEqual(["b.md"]);
  });
  test("returns [] for a project with no root", async () => {
    const fs = new FsFiles(async () => undefined);
    expect(await fs.list("ghost")).toEqual([]);
  });
  test("reads/writes within the resolved root and blocks traversal", async () => {
    const a = root({ "a.md": "# A" });
    const fs = new FsFiles(async () => a);
    expect(await fs.read("pa", "a.md")).toBe("# A");
    await fs.write("pa", "sub/c.md", "hi");
    expect(await fs.read("pa", "sub/c.md")).toBe("hi");
    await expect(fs.read("pa", "../escape.md")).rejects.toThrow();
  });
  test("rejects read/write for a project with no root", async () => {
    const fs = new FsFiles(async () => undefined);
    await expect(fs.read("ghost", "a.md")).rejects.toThrow();
    await expect(fs.write("ghost", "a.md", "x")).rejects.toThrow();
  });
});
