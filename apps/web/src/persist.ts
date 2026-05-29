import type { Annotation } from "@orden/annotation-core";
import type { Host } from "@orden/host-api";

export interface PersistedDoc {
  markdown: string;
  records: Annotation[];
}

// Per-document state (markdown + annotations) in the host vault (ns "docs", one
// key per docKey). Hydrated into a cache at boot so loadState/saveState stay
// synchronous; saveState/clearState write through to the vault.
let host: Host | null = null;
let cache: Record<string, PersistedDoc> = {};

export async function hydrateDocs(h: Host): Promise<void> {
  host = h;
  const keys = await h.vault.list("docs");
  const entries = await Promise.all(
    keys.map(async (k) => [k, await h.vault.get<PersistedDoc>("docs", k)] as const),
  );
  cache = {};
  for (const [k, v] of entries) if (v) cache[k] = v;
}

export function saveState(docKey: string, markdown: string, records: Annotation[]): void {
  const payload: PersistedDoc = { markdown, records };
  cache[docKey] = payload;
  if (host) void host.vault.set("docs", docKey, payload);
}

export function loadState(docKey: string): PersistedDoc | null {
  return cache[docKey] ?? null;
}

export function clearState(docKey: string): void {
  delete cache[docKey];
  if (host) void host.vault.delete("docs", docKey);
}
