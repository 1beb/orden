import type { Anchor, TextQuoteSelector } from "./types";
import { BLOCK_ID_ATTR } from "./blockId";
import { offsetsFromRange, rangeFromOffsets } from "./textOffsets";

const QUOTE_CONTEXT = 32;

function closestBlock(node: Node): Element | null {
  let el: Element | null =
    node.nodeType === Node.ELEMENT_NODE
      ? (node as Element)
      : node.parentElement;
  while (el && !el.hasAttribute(BLOCK_ID_ATTR)) {
    el = el.parentElement;
  }
  return el;
}

export function createAnchor(range: Range, _root: Element): Anchor {
  const block = closestBlock(range.startContainer);
  if (!block) throw new Error("selection is not inside a stamped block");

  const blockId = block.getAttribute(BLOCK_ID_ATTR)!;
  const text = block.textContent ?? "";
  const { start, end } = offsetsFromRange(block, range);

  return {
    blockId,
    position: { start, end },
    quote: {
      exact: text.slice(start, end),
      prefix: text.slice(Math.max(0, start - QUOTE_CONTEXT), start),
      suffix: text.slice(end, end + QUOTE_CONTEXT),
    },
  };
}

function findQuoteOffset(haystack: string, quote: TextQuoteSelector): number {
  const withContext = quote.prefix + quote.exact + quote.suffix;
  const ctxIdx = haystack.indexOf(withContext);
  if (ctxIdx !== -1) return ctxIdx + quote.prefix.length;
  return haystack.indexOf(quote.exact);
}

export function resolveAnchor(anchor: Anchor, root: Element): Range | null {
  const block = root.querySelector(
    `[${BLOCK_ID_ATTR}="${anchor.blockId}"]`,
  );

  if (block && anchor.quote) {
    const text = block.textContent ?? "";
    const at = findQuoteOffset(text, anchor.quote);
    if (at !== -1) {
      return rangeFromOffsets(block, at, at + anchor.quote.exact.length);
    }
  }

  // Repair: search every stamped block for the quote.
  if (anchor.quote) {
    const blocks = root.querySelectorAll(`[${BLOCK_ID_ATTR}]`);
    for (const candidate of Array.from(blocks)) {
      const text = candidate.textContent ?? "";
      const at = findQuoteOffset(text, anchor.quote);
      if (at !== -1) {
        return rangeFromOffsets(candidate, at, at + anchor.quote.exact.length);
      }
    }
  }

  return null;
}
