import { BLOCK_ID_ATTR } from "./blockId";
import { rangeFromOffsets } from "./textOffsets";
import type { Selector, TextQuoteSelector, TextPositionSelector } from "./wadm";

// The quote scorer below is intentionally duplicated from anchor.ts (which
// resolves the legacy Anchor type) — Phase 1 is additive and must not edit
// anchor.ts. The two copies have already diverged slightly (this one guards
// exact.length === 0). Keep them in sync, or extract a shared scorer in Phase 2
// once anchor.ts is in scope for the switch-over.

function commonSuffixLength(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}
function commonPrefixLength(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

function resolveQuote(sel: TextQuoteSelector, root: Element): Range | null {
  if (sel.exact.length === 0) return null;
  const occurrences: { block: Element; at: number; score: number }[] = [];
  for (const block of Array.from(root.querySelectorAll(`[${BLOCK_ID_ATTR}]`))) {
    const text = block.textContent ?? "";
    let from = 0;
    let at = text.indexOf(sel.exact, from);
    while (at !== -1) {
      const before = text.slice(0, at);
      const after = text.slice(at + sel.exact.length);
      const score = commonSuffixLength(before, sel.prefix) + commonPrefixLength(after, sel.suffix);
      occurrences.push({ block, at, score });
      from = at + 1;
      at = text.indexOf(sel.exact, from);
    }
  }
  if (occurrences.length === 0) return null;
  let chosen = occurrences[0];
  if (occurrences.length > 1) {
    const maxScore = Math.max(...occurrences.map((o) => o.score));
    const top = occurrences.filter((o) => o.score === maxScore);
    if (top.length !== 1) return null; // ambiguous -> orphan
    chosen = top[0];
  }
  return rangeFromOffsets(chosen.block, chosen.at, chosen.at + sel.exact.length);
}

function resolvePosition(sel: TextPositionSelector, root: Element): Range | null {
  if (!sel.blockId) return null;
  const block = root.querySelector(`[${BLOCK_ID_ATTR}="${sel.blockId}"]`);
  if (!block) return null;
  return rangeFromOffsets(block, sel.start, sel.end);
}

function resolveOne(sel: Selector, root: Element): Range | null {
  switch (sel.type) {
    case "text-quote":
      return resolveQuote(sel, root);
    case "text-position":
      return resolvePosition(sel, root);
    case "region":
      return null; // rendered as an overlay box, not a DOM Range
  }
}

// Try selectors in order; return the first that resolves to a Range.
export function resolveSelectors(selector: Selector | Selector[], root: Element): Range | null {
  const list = Array.isArray(selector) ? selector : [selector];
  for (const sel of list) {
    const range = resolveOne(sel, root);
    if (range) return range;
  }
  return null;
}
