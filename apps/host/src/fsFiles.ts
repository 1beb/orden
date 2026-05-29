// FileSource over the real filesystem, rooted at a directory. Lists markdown
// files (repo-relative, skipping heavy dirs) and reads/writes them. projectId
// is ignored for now (single root); multi-project mapping comes with H2.2.

import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { join, relative, dirname, sep } from "node:path";
import type { FileSource, FileEntry } from "@orden/host-api";

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  ".codegraph",
  ".playwright-mcp",
]);

function titleOf(content: string, path: string): string {
  const heading = content.match(/^#\s+(.+)$/m);
  if (heading) return heading[1].trim();
  return path.split("/").pop() ?? path;
}

export class FsFiles implements FileSource {
  constructor(private readonly root: string) {}

  private resolveInRoot(path: string): string {
    const full = join(this.root, path);
    const rel = relative(this.root, full);
    if (rel.startsWith("..") || rel.startsWith(sep + "..")) {
      throw new Error(`FsFiles: path escapes root: ${path}`);
    }
    return full;
  }

  private async walk(dir: string, out: string[]): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
        await this.walk(join(dir, e.name), out);
      } else if (e.isFile() && e.name.endsWith(".md")) {
        out.push(join(dir, e.name));
      }
    }
  }

  async list(_projectId: string, _glob?: string): Promise<FileEntry[]> {
    const abs: string[] = [];
    await this.walk(this.root, abs);
    const entries = await Promise.all(
      abs.map(async (file) => {
        const path = relative(this.root, file).split(sep).join("/");
        const content = await readFile(file, "utf8");
        return { path, title: titleOf(content, path) };
      }),
    );
    return entries.sort((a, b) => a.path.localeCompare(b.path));
  }

  async read(_projectId: string, path: string): Promise<string> {
    return readFile(this.resolveInRoot(path), "utf8");
  }

  async write(_projectId: string, path: string, content: string): Promise<void> {
    const full = this.resolveInRoot(path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
  }
}
