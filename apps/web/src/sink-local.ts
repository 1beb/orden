import type { Annotation, SinkAdapter } from "@orden/annotation-core";

const OUTBOX_KEY = "orden:feedback-outbox";

export interface OutboxEntry {
  at: string;
  items: Annotation[];
}

/**
 * A SinkAdapter that persists feedback batches to localStorage. Drop-in
 * replacement for the in-memory sink; swappable for an MCP sink later with
 * no UI change.
 */
export class LocalStorageSink implements SinkAdapter {
  async send(batch: Annotation[]): Promise<void> {
    const outbox = readOutbox();
    outbox.push({ at: new Date().toISOString(), items: batch });
    localStorage.setItem(OUTBOX_KEY, JSON.stringify(outbox));
  }
}

/**
 * Reads the persisted outbox. Returns [] when the key is absent or the stored
 * value is malformed; never throws.
 */
export function readOutbox(): OutboxEntry[] {
  const raw = localStorage.getItem(OUTBOX_KEY);
  if (raw === null) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as OutboxEntry[]) : [];
  } catch {
    return [];
  }
}
