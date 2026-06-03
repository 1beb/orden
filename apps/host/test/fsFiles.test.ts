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
  test("titles by markdown H1 (filename fallback) and skips dotfiles/SKIP_DIRS", async () => {
    const a = root({
      "r.md": "# Real Title",
      "plain.md": "no heading",
      "main.ts": "code",
      ".env": "secret",
      "node_modules/pkg/x.md": "# Dep",
    });
    const fs = new FsFiles(async () => a);
    const entries = await fs.list("p");
    const paths = entries.map((e) => e.path);
    // Dotfiles and SKIP_DIRS (node_modules) are excluded; non-markdown is kept.
    expect(paths).toEqual(["main.ts", "plain.md", "r.md"]);
    expect(paths).not.toContain(".env");
    expect(paths.some((p) => p.startsWith("node_modules/"))).toBe(false);
    const byPath = Object.fromEntries(entries.map((e) => [e.path, e.title]));
    expect(byPath["r.md"]).toBe("Real Title"); // H1 extracted
    expect(byPath["plain.md"]).toBe("plain.md"); // headingless md → filename
    expect(byPath["main.ts"]).toBe("main.ts"); // non-markdown → filename
  });
  test("an absolute path cannot escape the root", async () => {
    const a = root({ "a.md": "# A" });
    const fs = new FsFiles(async () => a);
    // join(root, "/etc/passwd") strips the leading slash and scopes it under the
    // root, so this resolves to <root>/etc/passwd (nonexistent) and rejects —
    // it never reads the real /etc/passwd.
    await expect(fs.read("pa", "/etc/passwd")).rejects.toThrow();
  });
});
