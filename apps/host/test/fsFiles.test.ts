import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsFiles } from "../src/fsFiles";

let root: string;
let files: FsFiles;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "orden-fs-"));
  await writeFile(join(root, "readme.md"), "# Readme\n\nhello");
  await writeFile(join(root, "main.ts"), "export const x = 1;");
  await writeFile(join(root, "data.json"), '{"a":1}');
  await writeFile(join(root, ".env"), "SECRET=1"); // dotfiles are skipped
  await mkdir(join(root, "docs"), { recursive: true });
  await writeFile(join(root, "docs", "plan.md"), "- no heading here");
  await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
  await writeFile(join(root, "node_modules", "pkg", "junk.md"), "# Junk");
  files = new FsFiles(root);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("FsFiles", () => {
  test("lists all files (repo-relative), excluding node_modules and dotfiles", async () => {
    const list = await files.list("repo");
    const paths = list.map((f) => f.path).sort();
    expect(paths).toEqual(["data.json", "docs/plan.md", "main.ts", "readme.md"]);
  });

  test("markdown titles come from the first heading, else the filename", async () => {
    const list = await files.list("repo");
    const byPath = Object.fromEntries(list.map((f) => [f.path, f.title]));
    expect(byPath["readme.md"]).toBe("Readme");
    expect(byPath["docs/plan.md"]).toBe("plan.md");
  });

  test("non-markdown files are titled by filename (content not read)", async () => {
    const list = await files.list("repo");
    const byPath = Object.fromEntries(list.map((f) => [f.path, f.title]));
    expect(byPath["main.ts"]).toBe("main.ts");
    expect(byPath["data.json"]).toBe("data.json");
  });

  test("read returns file contents by repo-relative path", async () => {
    expect(await files.read("repo", "readme.md")).toBe("# Readme\n\nhello");
  });

  test("write then read round-trips", async () => {
    await files.write("repo", "docs/plan.md", "# Plan\n\nupdated");
    expect(await files.read("repo", "docs/plan.md")).toBe("# Plan\n\nupdated");
  });

  test("read throws for a path escaping the root", async () => {
    await expect(files.read("repo", "../secret")).rejects.toThrow();
  });
});
