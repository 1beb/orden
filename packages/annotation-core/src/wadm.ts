// WADM-shaped annotation model. See docs/plans/2026-05-31-orden-web-annotation-design.md.
// The W3C Web Annotation Data MODEL (not strict JSON-LD): plain JSON, plus an
// `orden:` superset carrying the conversational layer WADM lacks.

export type Source =
  | { kind: "file"; vaultPath: string; contentHash: string; title?: string }
  | { kind: "web"; url: string; snapshotPath: string; contentHash: string; title?: string };

export interface TextQuoteSelector {
  type: "text-quote";
  exact: string;
  prefix: string;
  suffix: string;
  blockId?: string;
}

export interface TextPositionSelector {
  type: "text-position";
  start: number;
  end: number;
  blockId?: string;
}

export interface RegionSelector {
  type: "region";
  page?: number;
  // Normalized 0-1 for resolution independence (image / scanned PDF).
  rect: { x: number; y: number; w: number; h: number };
}

export type Selector = TextQuoteSelector | TextPositionSelector | RegionSelector;

export interface AnnotationReply {
  author: "user" | "agent";
  body: string;
  createdAt: string;
}

export type OrdenStatus = "open" | "sent" | "resolved";
export type OrdenAudience = "agent" | "human";

export interface OrdenAnnotation {
  id: string;
  created: string;
  creator: { kind: "human" | "agent"; id: string };
  target: {
    source: Source;
    // Single selector, or an ordered array of fallbacks (try first that resolves).
    selector: Selector | Selector[];
  };
  body: { text: string; tags?: string[]; color?: string };

  // orden: conversational superset (strict superset over WADM).
  "orden:status": OrdenStatus;
  "orden:audience": OrdenAudience;
  "orden:thread": AnnotationReply[];
}
