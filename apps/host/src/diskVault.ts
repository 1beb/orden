// DiskVault: a disk-backed VaultStore for NodeHost.
// Layout: <root>/<ns>/<encoded-key>.json — one JSON file per key. Keys and
// namespaces are percent-encoded so arbitrary strings (slashes, spaces) are
// safe and reversible as filenames.

import { readFile, writeFile, readdir, mkdir, rm, rename } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { VaultStore } from "@orden/host-api";

// Monotonic per-process counter so each atomic write gets a UNIQUE temp file.
// Keying the temp name on pid alone collides when two writes to the same key
// overlap (e.g. the launch-on-create reactor clearing a flag while the web
// write-through persists the same record): both write the same temp, the first
// rename consumes it, the second rename hits ENOENT and crashes the host.
let writeSeq = 0;

export class DiskVault implements VaultStore {
  constructor(private readonly root: string) {}

  private nsDir(ns: string): string {
    return join(this.root, encodeURIComponent(ns));
  }

  private keyPath(ns: string, key: string): string {
    return join(this.nsDir(ns), `${encodeURIComponent(key)}.json`);
  }

  async get<T>(ns: string, key: string): Promise<T | null> {
    let raw: string;
    try {
      raw = await readFile(this.keyPath(ns, key), "utf8");
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    // A corrupt entry (e.g. a 0-byte or partial file from a write that died
    // mid-flush) must not be fatal: treat it as absent so one bad key can't
    // take down hydrate-at-boot for the whole app. Matches BrowserHost.get.
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  async set<T>(ns: string, key: string, value: T): Promise<void> {
    const path = this.keyPath(ns, key);
    await mkdir(dirname(path), { recursive: true });
    // Atomic write: a crash between truncate and flush of an in-place writeFile
    // leaves a 0-byte file. Write a temp sibling then rename (atomic on POSIX)
    // so a reader only ever sees the complete old or complete new content. The
    // temp name is unique per call (pid + seq) so concurrent writes to the same
    // key each rename their own temp — last rename wins, none collide.
    const tmp = `${path}.${process.pid}.${++writeSeq}.tmp`;
    await writeFile(tmp, JSON.stringify(value), "utf8");
    await rename(tmp, path);
  }

  async list(ns: string): Promise<string[]> {
    let entries: string[];
    try {
      entries = await readdir(this.nsDir(ns));
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    return entries
      .filter((name) => name.endsWith(".json"))
      .map((name) => decodeURIComponent(name.slice(0, -".json".length)));
  }

  async delete(ns: string, key: string): Promise<void> {
    await rm(this.keyPath(ns, key), { force: true });
  }
}
