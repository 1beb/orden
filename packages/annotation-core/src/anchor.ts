import type { Anchor } from "./types";
import { BLOCK_ID_ATTR } from "./blockId";
import { offsetsFromRange } from "./textOffsets";

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
