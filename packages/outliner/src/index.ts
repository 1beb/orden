export * from "./types";
export {
  createBlock,
  createRoot,
  findBlock,
  indent,
  outdent,
  moveUp,
  moveDown,
  splitBlock,
  mergeWithPrevious,
  toggleCollapse,
} from "./blockTree";
export { toMarkdown, fromMarkdown } from "./markdown";
export { extractLinks } from "./links";
export { buildBacklinkIndex } from "./backlinks";
export type { BacklinkRef, BacklinkIndex } from "./backlinks";
export { journalKey, createJournalPage, createPage } from "./page";
// Generic board primitives. The lane set is received as a parameter — the outliner
// carries NO orden lane/policy constants (those moved to @orden/host-api). See
// docs/plans/2026-06-19-on-hold-and-lifecycle-config.md.
export { buildBoard } from "./kanban";
export { renderBoard } from "./kanbanView";
export type { RenderBoardOptions } from "./kanbanView";
