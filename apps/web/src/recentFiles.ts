// Recently-opened repo files, persisted in the host vault (ns "ui", key
// "recent-files") as an array of repo-relative paths, most-recent first,
// de-duplicated and capped. The FILES nav shows the top few; the store keeps a
// slightly deeper history. Hydrated at boot; writes write through.
import type { Host } from "@orden/host-api";

const NS = "ui";
const KEY = "recent-files";
const STORE_CAP = 10; // how many we persist
export const SHOW_CAP = 5; // how many the FILES nav renders

let host: Host | null = null;
let cache: string[] = [];

export async function hydrateRecentFiles(h: Host): Promise<void> {
  host = h;
  const stored = await h.vault.get<string[]>(NS, KEY);
  cache = Array.isArray(stored) ? stored.slice(0, STORE_CAP) : [];
}

/** Paths most-recent first. Pass a cap to limit (defaults to the full store). */
export function listRecentFiles(cap: number = STORE_CAP): string[] {
  return cache.slice(0, cap);
}

/** Record an opened file: move/insert to the front, de-dup, cap, persist. */
export function recordRecentFile(path: string): void {
  cache = [path, ...cache.filter((p) => p !== path)].slice(0, STORE_CAP);
  if (host) void host.vault.set(NS, KEY, cache);
}
