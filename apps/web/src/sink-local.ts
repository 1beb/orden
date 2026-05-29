import type { Annotation, SinkAdapter } from "@orden/annotation-core";
import type { Host } from "@orden/host-api";

export interface OutboxEntry {
  at: string;
  items: Annotation[];
}

// Feedback outbox in the host vault (ns "feedback", key "outbox"). The cache is
// hydrated at boot so readOutbox stays synchronous; send appends and writes
// through. Swappable for an MCP sink later with no UI change.
let host: Host | null = null;
let cache: OutboxEntry[] = [];

export async function hydrateOutbox(h: Host): Promise<void> {
  host = h;
  const stored = await h.vault.get<OutboxEntry[]>("feedback", "outbox");
  cache = Array.isArray(stored) ? stored : [];
}

export class VaultSink implements SinkAdapter {
  async send(batch: Annotation[]): Promise<void> {
    cache.push({ at: new Date().toISOString(), items: batch });
    if (host) await host.vault.set("feedback", "outbox", cache);
  }
}

/** The persisted outbox (from cache). Never throws. */
export function readOutbox(): OutboxEntry[] {
  return cache;
}
