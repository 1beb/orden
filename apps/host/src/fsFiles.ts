// FileSource over the real filesystem, rooted at a directory. Lists every file
// (repo-relative, skipping heavy/dot dirs) and reads/writes them. projectId is
// ignored for now (single root); multi-project mapping comes with H2.2.

import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import { join, relative, dirname, sep } from "node:path";
import type { FileSource, FileEntry } from "@orden/host-api";

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
      } else if (e.isFile() && !e.name.startsWith(".")) {
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
        // Only markdown earns a content read (for its H1 title); other files are
        // labeled by filename, so we never slurp a binary just to list it.
        const content = file.endsWith(".md") ? await readFile(file, "utf8") : undefined;
        return { path, title: titleOf(path, content) };
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

  // Watch the root for file changes (recursive) and report repo-relative paths.
  // Coalesces bursts per-path (editors write in several syscalls). The returned
  // FSWatcher is unref'd so it never keeps the process alive on its own.
  watch(onChange: (path: string) => void): FSWatcher {
    const timers = new Map<string, NodeJS.Timeout>();
    const watcher = watch(this.root, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      const rel = filename.toString().split(sep).join("/");
      if (rel.split("/").some((seg) => SKIP_DIRS.has(seg) || seg.startsWith("."))) return;
      const prev = timers.get(rel);
      if (prev) clearTimeout(prev);
      timers.set(
        rel,
        setTimeout(() => {
          timers.delete(rel);
          onChange(rel);
        }, 120).unref(),
      );
    });
    // Node's recursive watcher walks the whole tree to arm itself, including
    // node_modules; a build artifact dir (e.g. node-gyp's node_gyp_bins) that
    // vanishes mid-scandir emits a transient ENOENT. Without a handler that
    // 'error' event is unhandled and crashes the host. Swallow it so the
    // watcher (and process) survive churn under node_modules.
    watcher.on("error", (err) => {
      console.warn(`[fsFiles] watch error (ignored): ${(err as Error).message}`);
    });
    watcher.unref();
    return watcher;
  }
}
