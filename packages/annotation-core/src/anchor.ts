import type { Anchor } from "./types";
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

function commonSuffixLength(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) {
    n++;
  }
  return n;
}

function commonPrefixLength(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) {
    n++;
  }
  return n;
}

interface Occurrence {
  block: Element;
  at: number;
  score: number;
}

export function resolveAnchor(anchor: Anchor, root: Element): Range | null {
  const quote = anchor.quote;
  if (!quote || quote.exact.length === 0) return null;

  const occurrences: Occurrence[] = [];
  const blocks = root.querySelectorAll(`[${BLOCK_ID_ATTR}]`);
  for (const block of Array.from(blocks)) {
    const text = block.textContent ?? "";
    let from = 0;
    let at = text.indexOf(quote.exact, from);
    while (at !== -1) {
      const before = text.slice(0, at);
      const after = text.slice(at + quote.exact.length);
      const prefixScore = commonSuffixLength(before, quote.prefix);
      const suffixScore = commonPrefixLength(after, quote.suffix);
      occurrences.push({ block, at, score: prefixScore + suffixScore });
      from = at + 1;
      at = text.indexOf(quote.exact, from);
    }
  }

  if (occurrences.length === 0) return null;

  let chosen: Occurrence;
  if (occurrences.length === 1) {
    chosen = occurrences[0];
  } else {
    const maxScore = Math.max(...occurrences.map((o) => o.score));
    const top = occurrences.filter((o) => o.score === maxScore);
    if (top.length !== 1) return null; // ambiguous -> orphan
    chosen = top[0];
  }

  return rangeFromOffsets(
    chosen.block,
    chosen.at,
    chosen.at + quote.exact.length,
  );
}
