// Watches ONLY the files a client has explicitly opened, not whole project
// trees. watch(projectId, relPath) arms a single non-recursive fs.watch on that
// file's parent directory (refcounted, so several open docs in one dir share
// one watch) and emits (projectId, relPath) when that specific file changes.
// unwatch() releases it. This replaced MultiRootWatcher, whose recursive watch
// over every project root walked node_modules to arm and exhausted inotify
// (ENOSPC); here nothing is watched until a doc is open, and only its parent
// dir is.
//
// Why the PARENT DIR and not the file: editors save atomically (write a temp
// file, rename it over the original), which swaps the inode. A watch on the
// file's own path stops firing after such a save; a non-recursive watch on the
// directory survives it and still sees the rename. We filter dir events down to
// the basenames actually open, so a busy dir doesn't spam the feed.

import { watch, type FSWatcher } from "node:fs";
import { dirname, join, sep } from "node:path";

type ResolveRoot = (projectId: string) => Promise<string | undefined>;

type DirEntry = { watcher: FSWatcher; refs: number };

export class OpenDocWatcher {
  // Refcount of explicit watch() calls per `${projectId}\0${relPath}` — repeated
  // opens of the same doc coalesce, and the last unwatch tears the dir watch down.
  private readonly docs = new Map<string, number>();
  // The dir-watch key backing each watched doc, recorded at watch() time so
  // unwatch() never has to re-resolve a root that may since have gone away.
  private readonly docDir = new Map<string, string>();
  // One non-recursive watcher per `${projectId}\0${absDir}`, refcounted by the
  // number of open docs living directly in that dir.
  private readonly dirs = new Map<string, DirEntry>();
  // Per-doc debounce timers, keyed like `docs`, to coalesce editor write bursts.
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private stopped = false;

  constructor(
    private readonly resolveRoot: ResolveRoot,
    private readonly onChange: (projectId: string, relPath: string) => void,
  ) {}

  // Begin watching one repo-relative doc. Idempotent per (projectId, relPath):
  // a second watch() just bumps the refcount, so it pairs 1:1 with unwatch().
  async watch(projectId: string, relPath: string): Promise<void> {
    if (this.stopped) return;
    const rel = normalize(relPath);
    const docKey = `${projectId}\0${rel}`;
    const n = (this.docs.get(docKey) ?? 0) + 1;
    this.docs.set(docKey, n);
    if (n > 1) return; // already watching this doc — dir watch is up.

    const root = await this.resolveRoot(projectId);
    // Bail if stopped or unwatched mid-resolve, or the project has no root.
    if (this.stopped || !root || !this.docs.has(docKey)) return;

    const absDir = dirname(join(root, rel));
    const dirKey = `${projectId}\0${absDir}`;
    this.docDir.set(docKey, dirKey);

    const existing = this.dirs.get(dirKey);
    if (existing) {
      existing.refs++;
      return;
    }
    // Directory of `rel` relative to root: "" when the doc sits at the root.
    const slash = rel.lastIndexOf("/");
    const dirRel = slash === -1 ? "" : rel.slice(0, slash);
    let watcher: FSWatcher;
    try {
      watcher = watch(absDir, { recursive: false }, (_event, filename) => {
        if (this.stopped || !filename) return;
        const base = filename.toString();
        const candidate = dirRel ? `${dirRel}/${base}` : base;
        const candKey = `${projectId}\0${candidate}`;
        if (!this.docs.has(candKey)) return; // not an open doc — ignore the sibling.
        const prev = this.timers.get(candKey);
        if (prev) clearTimeout(prev);
        this.timers.set(
          candKey,
          setTimeout(() => {
            this.timers.delete(candKey);
            if (this.stopped) return;
            this.onChange(projectId, candidate);
          }, 120).unref(),
        );
      });
    } catch (err) {
      // Arming can throw (ENOSPC when inotify is exhausted, ENOENT if the dir
      // vanished). An open must not fail because we couldn't watch it — the doc
      // just won't live-reload. Drop the dir mapping so unwatch stays balanced.
      console.warn(`[openDocWatcher] could not watch ${absDir} (ignored): ${(err as Error).message}`);
      this.docDir.delete(docKey);
      return;
    }
    // A non-recursive watch can still emit a transient 'error' (e.g. the dir is
    // removed). Swallow it so one vanished dir never crashes the host.
    watcher.on("error", (err) => {
      console.warn(`[openDocWatcher] watch error (ignored): ${(err as Error).message}`);
    });
    watcher.unref();
    this.dirs.set(dirKey, { watcher, refs: 1 });
  }

  // Stop watching one repo-relative doc. Closes the backing dir watcher once no
  // open doc needs it. Safe to call for an unknown doc (no-op).
  unwatch(projectId: string, relPath: string): void {
    const rel = normalize(relPath);
    const docKey = `${projectId}\0${rel}`;
    const n = this.docs.get(docKey);
    if (!n) return;
    if (n > 1) {
      this.docs.set(docKey, n - 1);
      return;
    }
    this.docs.delete(docKey);
    const prev = this.timers.get(docKey);
    if (prev) {
      clearTimeout(prev);
      this.timers.delete(docKey);
    }
    const dirKey = this.docDir.get(docKey);
    this.docDir.delete(docKey);
    if (!dirKey) return; // root never resolved; no dir watch was opened.
    const entry = this.dirs.get(dirKey);
    if (!entry) return;
    if (--entry.refs <= 0) {
      entry.watcher.close();
      this.dirs.delete(dirKey);
    }
  }

  // Close every watcher and clear state; no callbacks fire after this. Tests use
  // it to release fs.watch handles between hosts; production runs for the
  // process lifetime.
  stop(): void {
    this.stopped = true;
    for (const { watcher } of this.dirs.values()) watcher.close();
    this.dirs.clear();
    this.docs.clear();
    this.docDir.clear();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}

// Repo-relative paths cross the RPC boundary as POSIX, but normalize defensively
// so a stray platform separator can't desync the docs/dir keys.
function normalize(relPath: string): string {
  return relPath.split(sep).join("/");
}
