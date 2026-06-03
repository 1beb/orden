// Recently-opened repo files, persisted in the host vault (ns "ui", key
// "recent-files") as an array of {projectId, path}, most-recent first,
// de-duplicated and capped. Per-project file roots make a bare path ambiguous
// (the same path can live in two projects), so each entry carries its project.
// The FILES nav shows the top few; the store keeps a slightly deeper history.
// Hydrated at boot; writes write through. Legacy string[] data (paths only) is
// migrated to {projectId:"repo", path} on hydrate.
import type { Host } from "@orden/host-api";

const NS = "ui";
const KEY = "recent-files";
export const STORE_CAP = 10; // how many we persist
export const SHOW_CAP = 5; // how many the FILES nav renders

/** A recently-opened file, scoped to the project it belongs to. */
export interface RecentFile {
  projectId: string;
  path: string;
}

let host: Host | null = null;
let cache: RecentFile[] = [];

// Coerce a stored entry to a RecentFile, or null to drop it. Legacy strings
// become {projectId:"repo", path}; objects must have string projectId + path.
function coerce(entry: unknown): RecentFile | null {
  if (typeof entry === "string") return { projectId: "repo", path: entry };
  if (entry && typeof entry === "object") {
    const { projectId, path } = entry as Partial<RecentFile>;
    if (typeof projectId === "string" && typeof path === "string") return { projectId, path };
  }
  return null;
}

export async function hydrateRecentFiles(h: Host): Promise<void> {
  host = h;
  const stored = await h.vault.get<unknown>(NS, KEY);
  cache = Array.isArray(stored)
    ? stored.map(coerce).filter((e): e is RecentFile => e !== null).slice(0, STORE_CAP)
    : [];
}

/** Entries most-recent first. Pass a cap to limit (defaults to the full store). */
export function listRecentFiles(cap: number = STORE_CAP): RecentFile[] {
  return cache.slice(0, cap);
}

/** Record an opened file: move/insert to the front, de-dup, cap, persist. */
export function recordRecentFile(projectId: string, path: string): void {
  cache = [
    { projectId, path },
    ...cache.filter((e) => e.projectId !== projectId || e.path !== path),
  ].slice(0, STORE_CAP);
  if (host) void host.vault.set(NS, KEY, cache);
}
