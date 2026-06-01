import type { Annotation } from "./types";
import type { OrdenAnnotation, Selector, Source } from "./wadm";

export interface LegacyDocInput {
  vaultPath: string;
  contentHash: string;
  records: Annotation[];
}

export interface AnnotationBundle {
  source: Source;
  annotations: OrdenAnnotation[];
}

function anchorToSelectors(a: Annotation["anchor"]): Selector[] {
  const out: Selector[] = [];
  if (a.quote) {
    out.push({ type: "text-quote", exact: a.quote.exact, prefix: a.quote.prefix, suffix: a.quote.suffix, blockId: a.blockId });
  }
  if (a.position) {
    out.push({ type: "text-position", start: a.position.start, end: a.position.end, blockId: a.blockId });
  }
  return out;
}

export function migrateLegacyDoc(input: LegacyDocInput): AnnotationBundle {
  // `source` is deliberately reference-shared across every annotation in the
  // bundle (and is the same object returned as bundle.source): one source,
  // many annotations. Treat it as immutable; don't mutate target.source in place.
  const source: Source = { kind: "file", vaultPath: input.vaultPath, contentHash: input.contentHash };
  const annotations: OrdenAnnotation[] = input.records.map((r) => ({
    id: r.id,
    created: r.createdAt,
    // Synthetic placeholder: the legacy Annotation has no creator identity.
    // Phase 2 wires the real id via host.identity.me() at migration time.
    creator: { kind: "human", id: "me" },
    target: { source, selector: anchorToSelectors(r.anchor) },
    body: { text: r.body },
    "orden:status": r.status,
    "orden:audience": r.target,
    "orden:thread": r.thread.map((t) => ({ author: t.author, body: t.body, createdAt: t.createdAt })),
  }));
  return { source, annotations };
}
