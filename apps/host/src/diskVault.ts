// DiskVault: a disk-backed VaultStore for NodeHost.
// Layout: <root>/<ns>/<encoded-key>.json — one JSON file per key. Keys and
// namespaces are percent-encoded so arbitrary strings (slashes, spaces) are
// safe and reversible as filenames.

import { readFile, writeFile, readdir, mkdir, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { VaultStore } from "@orden/host-api";

export class DiskVault implements VaultStore {
  constructor(private readonly root: string) {}

  private nsDir(ns: string): string {
    return join(this.root, encodeURIComponent(ns));
  }

  private keyPath(ns: string, key: string): string {
    return join(this.nsDir(ns), `${encodeURIComponent(key)}.json`);
  }

  async get<T>(ns: string, key: string): Promise<T | null> {
    try {
      const raw = await readFile(this.keyPath(ns, key), "utf8");
      return JSON.parse(raw) as T;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async set<T>(ns: string, key: string, value: T): Promise<void> {
    const path = this.keyPath(ns, key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(value), "utf8");
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
