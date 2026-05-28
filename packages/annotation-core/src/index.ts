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
