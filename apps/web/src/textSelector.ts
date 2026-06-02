import { BLOCK_ID_ATTR, offsetsFromRange, type Selector } from "@orden/annotation-core";

const QUOTE_CONTEXT = 32;

// Nearest ancestor element carrying a block id (the unit resolveSelectors works in).
function closestBlock(node: Node): Element | null {
  let el: Element | null =
    node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  while (el && !el.hasAttribute(BLOCK_ID_ATTR)) el = el.parentElement;
  return el;
}

// Convert a non-collapsed selection Range into [text-quote, text-position] fallbacks.
// Offsets are into the block's concatenated textContent (via offsetsFromRange), so
// the text-position selector round-trips through resolveSelectors.
export function selectorsForRange(range: Range, _root: Element): Selector[] {
  if (range.collapsed) return [];

  const block = closestBlock(range.startContainer);
  const endBlock = closestBlock(range.endContainer);
  if (!block || block !== endBlock) {
    // Cross-block (or unstamped) selection: quote-only, position needs one block.
    const exact = range.toString();
    if (!exact) return [];
    return [{ type: "text-quote", exact, prefix: "", suffix: "" }];
  }

  const text = block.textContent ?? "";
  const { start, end } = offsetsFromRange(block, range);
  const exact = text.slice(start, end);
  if (!exact) return [];

  const blockId = block.getAttribute(BLOCK_ID_ATTR) ?? undefined;
  // Raw 32-char context window on each side — same convention as annotations.ts /
  // anchor.ts. The resolver scores by common prefix/suffix length, so a window that
  // over-reaches by a word is harmless; consistency across the codebase wins.
  const prefix = text.slice(Math.max(0, start - QUOTE_CONTEXT), start);
  const suffix = text.slice(end, Math.min(text.length, end + QUOTE_CONTEXT));

  return [
    { type: "text-quote", exact, prefix, suffix, blockId },
    { type: "text-position", start, end, blockId },
  ];
}
