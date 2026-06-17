// NodeHost's SearchService: thin async facade over the synchronous VaultIndex,
// plus a live indexer that keeps the index current off the vault change feed.
import type {
  SearchService,
  SearchHit,
  BacklinkHit,
  SearchEntryNs,
  VaultStore,
} from "@orden/host-api";
import { VaultIndex, type EntryNs } from "./vaultIndex";

interface PageMeta {
  created?: string;
  updated?: string;
}

// Namespaces whose writes affect the index: the two content stores plus the
// timestamp sidecar (a pagemeta-only write should refresh created/updated).
const INDEXED_NS = new Set(["pages", "journal", "pagemeta"]);

export class NodeSearchService implements SearchService {
  constructor(private readonly index: VaultIndex) {}

  async query(text: string, opts?: { kinds?: SearchEntryNs[]; limit?: number }): Promise<SearchHit[]> {
    return this.index.query(text, opts);
  }

  async backlinks(target: string): Promise<BacklinkHit[]> {
    return this.index.backlinks(target);
  }

  async backlinkCounts(): Promise<Record<string, number>> {
    return this.index.backlinkCounts();
  }
}

// Subscribe the index to vault writes. Returns an unsubscribe fn. Reads the
// changed entry transiently from the vault (local disk on the host) and upserts
// or removes it — so the index reflects writes from ANY bus (web, MCP, reactors).
export function attachIndexer(
  index: VaultIndex,
  vault: VaultStore,
  onChange: (listener: (c: { ns: string; key: string }) => void) => () => void,
): () => void {
  return onChange((c) => {
    if (!INDEXED_NS.has(c.ns)) return;
    void reindexEntry(index, vault, c.ns, c.key).catch((err) => {
      console.error(`vault index update failed (${c.ns}/${c.key}):`, err);
    });
  });
}

async function reindexEntry(index: VaultIndex, vault: VaultStore, ns: string, key: string): Promise<void> {
  // A pagemeta write carries no body; find whichever content store holds the
  // name and re-upsert it so the timestamps refresh.
  if (ns === "pagemeta") {
    for (const store of ["pages", "journal"] as const) {
      const body = await vault.get<string>(store, key);
      if (body != null) {
        const meta = await vault.get<PageMeta>("pagemeta", key);
        index.upsertEntry(store, key, body, meta?.created, meta?.updated);
        return;
      }
    }
    return;
  }
  const store = ns as EntryNs;
  const body = await vault.get<string>(store, key);
  if (body == null) {
    index.removeEntry(store, key);
    return;
  }
  const meta = await vault.get<PageMeta>("pagemeta", key);
  index.upsertEntry(store, key, body, meta?.created, meta?.updated);
}
