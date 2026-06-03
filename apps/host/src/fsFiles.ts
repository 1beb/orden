// FileSource over the real filesystem. Each projectId resolves (via a
// ProjectRootResolver) to its own absolute root; list/read/write are scoped to
// that root and reject paths escaping it.

import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { join, relative, dirname, sep } from "node:path";
import type { FileSource, FileEntry } from "@orden/host-api";
import type { ProjectRootResolver } from "./projectRoots";
import { pickDirectory } from "./pickDirectory";

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  ".codegraph",
  ".playwright-mcp",
]);

// A markdown file's title is its first H1, if any; everything else (and any
// headingless markdown) falls back to the bare filename. Only markdown content
// is inspected, so listing never reads a binary just to label it.
function titleOf(path: string, content?: string): string {
  if (content !== undefined) {
    const heading = content.match(/^#\s+(.+)$/m);
    if (heading) return heading[1].trim();
  }
  return path.split("/").pop() ?? path;
}

export class FsFiles implements FileSource {
  constructor(private readonly resolveRoot: ProjectRootResolver) {}

  // Resolve a project's root, throwing when it has none — used by read/write,
  // which (unlike list) cannot silently no-op on a missing root.
  private async rootFor(projectId: string): Promise<string> {
    const root = await this.resolveRoot(projectId);
    if (!root) throw new Error(`FsFiles: no root for project ${projectId}`);
    return root;
  }

  private resolveInRoot(root: string, path: string): string {
    const full = join(root, path);
    const rel = relative(root, full);
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
      } else if (e.isFile() && !e.name.startsWith(".")) {
        out.push(join(dir, e.name));
      }
    }
  }

  async list(projectId: string, _glob?: string): Promise<FileEntry[]> {
    const root = await this.resolveRoot(projectId);
    if (!root) return [];
    const abs: string[] = [];
    await this.walk(root, abs);
    const entries = await Promise.all(
      abs.map(async (file) => {
        const path = relative(root, file).split(sep).join("/");
        // Only markdown earns a content read (for its H1 title); other files are
        // labeled by filename, so we never slurp a binary just to list it.
        const content = file.endsWith(".md") ? await readFile(file, "utf8") : undefined;
        return { path, title: titleOf(path, content) };
      }),
    );
    return entries.sort((a, b) => a.path.localeCompare(b.path));
  }

  async read(projectId: string, path: string): Promise<string> {
    const root = await this.rootFor(projectId);
    return readFile(this.resolveInRoot(root, path), "utf8");
  }

  async write(projectId: string, path: string, content: string): Promise<void> {
    const root = await this.rootFor(projectId);
    const full = this.resolveInRoot(root, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
  }

  // Native directory chooser — filesystem-wide, not scoped to this root, so the
  // user can pick a folder anywhere when creating a project.
  pickDirectory(opts?: { title?: string; startPath?: string }): Promise<string | null> {
    return pickDirectory(opts);
  }
}
