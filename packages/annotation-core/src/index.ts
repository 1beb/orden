export * from "./types";
export { createAnnotation } from "./annotation";
// computeBlockId/assignBlockIds are NOT the annotation anchor anymore (ProseMirror
// marks are). Kept exported for possible coarse uses (e.g. MCP open_in_main_view
// targeting); safe to drop if unused.
export { computeBlockId, assignBlockIds, BLOCK_ID_ATTR } from "./blockId";
export { rangeFromOffsets, offsetsFromRange } from "./textOffsets";
export { createAnchor, resolveAnchor } from "./anchor";
export { MemorySink, sendFeedback } from "./sink";
export type { SinkAdapter } from "./sink";

// --- WADM foundation (web annotation Phase 1) ---
// NOTE: wadm.ts also exports TextQuoteSelector / TextPositionSelector, but the
// legacy types.ts (re-exported via `export * from "./types"`) owns those names.
// Consumers use the `Selector` union, so the WADM selector subtypes are
// intentionally NOT re-exported here to avoid duplicate-identifier conflicts.
export type {
  Source,
  Selector,
  RegionSelector,
  OrdenAnnotation,
  OrdenStatus,
  OrdenAudience,
  AnnotationReply as OrdenReply,
} from "./wadm";
export { createOrdenAnnotation } from "./wadmFactory";
export { resolveSelectors } from "./selector";
export { sourceHash, contentHash } from "./hash";
export { migrateLegacyDoc } from "./migrate";
export type { AnnotationBundle, LegacyDocInput } from "./migrate";
