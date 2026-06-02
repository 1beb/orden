import type { VaultStore } from "@orden/host-api";
import type { OrdenAnnotation, Source } from "@orden/annotation-core";
import { sourceHash } from "@orden/annotation-core";

const NS = "annotations";

export interface AnnotationBundle {
  source: Source;
  annotations: OrdenAnnotation[];
}

// Helper: do two sources name the same thing? (identity, not bytes)
function sameSource(a: Source, b: Source): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind === "web" && b.kind === "web"
    ? a.url === b.url
    : (a as { vaultPath: string }).vaultPath === (b as { vaultPath: string }).vaultPath;
}

// Source-keyed annotation store. Bundles live in vault ns `annotations`, key =
// sourceHash(source); the host's DiskVault lands each as
// <vaultRoot>/annotations/<sourceHash>.json — legible on-disk JSON.
export class AnnotationStore {
  private cache = new Map<string, AnnotationBundle>();
  constructor(private readonly vault: VaultStore) {}

  async hydrate(): Promise<void> {
    const keys = await this.vault.list(NS);
    this.cache.clear();
    for (const k of keys) {
      const b = await this.vault.get<AnnotationBundle>(NS, k);
      if (b) this.cache.set(k, b);
    }
  }

  forSource(source: Source): OrdenAnnotation[] {
    const b = this.cache.get(sourceHash(source));
    if (!b || !sameSource(b.source, source)) return [];
    return b.annotations;
  }

  add(source: Source, ann: OrdenAnnotation): void {
    const key = sourceHash(source);
    const existing = this.cache.get(key);
    const bundle: AnnotationBundle =
      existing && sameSource(existing.source, source)
        ? { source, annotations: [...existing.annotations, ann] }
        : { source, annotations: [ann] };
    this.cache.set(key, bundle);
    void this.vault.set(NS, key, bundle);
  }

  remove(source: Source, id: string): void {
    const key = sourceHash(source);
    const existing = this.cache.get(key);
    if (!existing || !sameSource(existing.source, source)) return;
    const bundle = { source, annotations: existing.annotations.filter((a) => a.id !== id) };
    this.cache.set(key, bundle);
    void this.vault.set(NS, key, bundle);
  }

  replace(source: Source, id: string, next: OrdenAnnotation): void {
    const key = sourceHash(source);
    const existing = this.cache.get(key);
    if (!existing || !sameSource(existing.source, source)) return;
    const bundle = { source, annotations: existing.annotations.map((a) => (a.id === id ? next : a)) };
    this.cache.set(key, bundle);
    void this.vault.set(NS, key, bundle);
  }
}
