import type { AnnotationSendInput, AnnotationRef } from "@orden/host-api";
import type { OrdenAnnotation, Source, Selector } from "@orden/annotation-core";

function firstQuote(sel: Selector | Selector[]): string | undefined {
  const list = Array.isArray(sel) ? sel : [sel];
  const q = list.find((s) => s.type === "text-quote");
  return q && "exact" in q ? q.exact : undefined;
}

function firstBlockId(sel: Selector | Selector[]): string | undefined {
  const list = Array.isArray(sel) ? sel : [sel];
  for (const s of list) if ("blockId" in s && s.blockId) return s.blockId;
  return undefined;
}

// Map stored source annotations into the host's annotationSend input. planDoc is
// the source's vaultPath (file) or url (web); the host matches it against a
// card's plan doc / doc link / owning worktree. projectId lets a created session
// land in the right project instead of the ephemeral default.
export function toAnnotationSendInput(
  source: Source,
  anns: OrdenAnnotation[],
  projectId?: string,
): AnnotationSendInput {
  const planDoc = source.kind === "file" ? source.vaultPath : source.url;
  const annotations: AnnotationRef[] = anns.map((a) => ({
    id: a.id,
    planDoc,
    quote: firstQuote(a.target.selector),
    note: a.body.text,
    blockId: firstBlockId(a.target.selector),
  }));
  return { planDoc, annotations, ...(projectId ? { projectId } : {}) };
}
