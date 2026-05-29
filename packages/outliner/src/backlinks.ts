import type { Block, Page } from "./types";
import { extractLinks } from "./links";

/** One reference: which block, on which page, mentions a target. */
export interface BacklinkRef {
  pageName: string;
  blockId: string;
  /** The block's text, for previewing the reference in a backlinks panel. */
  text: string;
}

/** target page name -> blocks that link to it. */
export type BacklinkIndex = Record<string, BacklinkRef[]>;

/**
 * Build a stub backlink index by walking every block of every page and
 * recording each `[[target]]` reference. Re-derived from scratch; there is no
 * incremental update path yet (see README open questions).
 */
export function buildBacklinkIndex(pages: Page[]): BacklinkIndex {
  const index: BacklinkIndex = {};
  const visit = (page: Page, block: Block): void => {
    for (const target of extractLinks(block.text)) {
      (index[target] ??= []).push({
        pageName: page.name,
        blockId: block.id,
        text: block.text,
      });
    }
    for (const child of block.children) visit(page, child);
  };
  for (const page of pages) {
    for (const child of page.root.children) visit(page, child);
  }
  return index;
}
