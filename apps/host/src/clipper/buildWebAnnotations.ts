import type { OrdenAnnotation, Source } from "@orden/annotation-core";

export interface RawHighlight {
  exact: string;
  prefix: string;
  suffix: string;
  blockId: string;
  note: string;
  audience: "agent" | "human";
  shot?: string; // vault-relative screenshot path
}

/** Assemble WADM records from raw extension highlights. Pure; ids/timestamps injected. */
export function buildWebAnnotations(
  source: Source,
  highlights: RawHighlight[],
  mintId: () => string,
  now: () => string,
): OrdenAnnotation[] {
  return highlights.map((h): OrdenAnnotation => ({
    id: mintId(),
    created: now(),
    creator: { kind: "human", id: "user" },
    target: {
      source,
      selector: { type: "text-quote", exact: h.exact, prefix: h.prefix, suffix: h.suffix, blockId: h.blockId },
    },
    body: { text: h.note },
    "orden:status": "open",
    "orden:audience": h.audience,
    "orden:thread": [],
    ...(h.shot ? { "orden:shot": h.shot } : {}),
  }));
}
