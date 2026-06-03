// Watches every local project's root (recursive) and reports
// (projectId, repoRelativePath) on any in-root change. The set of roots is
// vault-driven and dynamic: refresh() re-reads it and diffs against the live
// watchers, opening/closing as projects are added, removed, or repathed.
//
// Port note: the per-root callback reproduces the robustness of the old
// FsFiles.watch (removed in Task 3) — per-path 120ms debounce to coalesce
// editor write bursts, SKIP_DIRS + dotfile filtering on the changed path, a
// swallowed 'error' handler (node's recursive watcher emits transient ENOENT
// while arming over churning trees like node_modules), and .unref() so a
// watcher never keeps the process alive on its own.

import { watch, type FSWatcher } from "node:fs";
import { sep } from "node:path";
import { SKIP_DIRS } from "./fsFiles";

export type LocalRoot = { id: string; root: string };

type Entry = { root: string; watcher: FSWatcher };

export class MultiRootWatcher {
  private readonly watchers = new Map<string, Entry>();
  // Debounce timers keyed by `${projectId}\0${relPath}`, so the same relative
  // path under two projects coalesces independently.
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private stopped = false;

  constructor(
    private readonly listLocalRoots: () => Promise<LocalRoot[]>,
    private readonly onChange: (projectId: string, path: string) => void,
  ) {}

  // Open watchers for the current local roots. Idempotent: delegates to the
  // same diff logic as refresh(), so a second start() never double-watches.
  async start(): Promise<void> {
    this.stopped = false;
    await this.refresh();
  }

  // Re-read the local roots and reconcile against the live watchers: open for
  // new ids or ids whose root changed (close+reopen), close for ids that are
  // gone. Task 5 calls this when the `projects` vault namespace changes.
  async refresh(): Promise<void> {
    if (this.stopped) return;
    const next = await this.listLocalRoots();
    if (this.stopped) return; // listLocalRoots is async; bail if stopped meanwhile.
    const wantById = new Map(next.map((r) => [r.id, r.root]));

    // Close watchers for ids that are gone or whose root moved.
    for (const [id, entry] of this.watchers) {
      const wantRoot = wantById.get(id);
      if (wantRoot === undefined || wantRoot !== entry.root) {
        entry.watcher.close();
        this.watchers.delete(id);
      }
    }

    // Open watchers for ids that are new or were just closed for a repath.
    for (const { id, root } of next) {
      if (!this.watchers.has(id)) {
        this.watchers.set(id, { root, watcher: this.openWatcher(id, root) });
      }
    }
  }

  // Close all watchers and clear state; no callbacks fire after this. Safe to
  // call repeatedly (double-stop is a no-op).
  stop(): void {
    this.stopped = true;
    for (const entry of this.watchers.values()) entry.watcher.close();
    this.watchers.clear();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private openWatcher(projectId: string, root: string): FSWatcher {
    const watcher = watch(root, { recursive: true }, (_event, filename) => {
      if (this.stopped || !filename) return;
      const rel = filename.toString().split(sep).join("/");
      if (rel.split("/").some((seg) => SKIP_DIRS.has(seg) || seg.startsWith("."))) return;
      const key = `${projectId}\0${rel}`;
      const prev = this.timers.get(key);
      if (prev) clearTimeout(prev);
      this.timers.set(
        key,
        setTimeout(() => {
          this.timers.delete(key);
          if (this.stopped) return;
          this.onChange(projectId, rel);
        }, 120).unref(),
      );
    });
    // Node's recursive watcher walks the whole tree to arm itself, including
    // node_modules; a build artifact dir that vanishes mid-scandir emits a
    // transient ENOENT. Without a handler that 'error' event is unhandled and
    // crashes the host. Swallow it so the watcher (and process) survive churn.
    watcher.on("error", (err) => {
      console.warn(`[multiRootWatcher] watch error (ignored): ${(err as Error).message}`);
    });
    watcher.unref();
    return watcher;
  }
}
