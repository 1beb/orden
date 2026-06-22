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

// Find every occurrence of `exact` inside `text`, scored by how much of the
// captured prefix/suffix still surrounds it (a tie-break for duplicate quotes).
function occurrencesIn(
  scope: Element,
  text: string,
  exact: string,
  sel: TextQuoteSelector,
): { scope: Element; at: number; score: number }[] {
  const out: { scope: Element; at: number; score: number }[] = [];
  let from = 0;
  let at = text.indexOf(exact, from);
  while (at !== -1) {
    const before = text.slice(0, at);
    const after = text.slice(at + exact.length);
    const score = commonSuffixLength(before, sel.prefix) + commonPrefixLength(after, sel.suffix);
    out.push({ scope, at, score });
    from = at + 1;
    at = text.indexOf(exact, from);
  }
  return out;
}

function chooseAndRange(
  occurrences: { scope: Element; at: number; score: number }[],
  exactLen: number,
): Range | null {
  if (occurrences.length === 0) return null;
  let chosen = occurrences[0];
  if (occurrences.length > 1) {
    const maxScore = Math.max(...occurrences.map((o) => o.score));
    const top = occurrences.filter((o) => o.score === maxScore);
    if (top.length !== 1) return null; // ambiguous -> orphan
    chosen = top[0];
  }
  return rangeFromOffsets(chosen.scope, chosen.at, chosen.at + exactLen);
}

// Resolve one candidate `exact` against the document: prefer a within-a-single-
// block match (keeps the range tight and matches same-block capture), else search
// `root` as one text run so a cross-block quote still resolves.
function resolveExact(exact: string, sel: TextQuoteSelector, root: Element): Range | null {
  if (exact.length === 0) return null;
  const perBlock: { scope: Element; at: number; score: number }[] = [];
  for (const block of Array.from(root.querySelectorAll(`[${BLOCK_ID_ATTR}]`))) {
    perBlock.push(...occurrencesIn(block, block.textContent ?? "", exact, sel));
  }
  if (perBlock.length > 0) return chooseAndRange(perBlock, exact.length);

  // No single block holds the quote. A cross-block selection (e.g. a paragraph
  // dragged into a following code block) captured `range.toString()`, which
  // concatenates text across the boundary with no separator — so it only exists
  // in the document-wide text. Search `root` as one text run and build a Range
  // that spans the blocks. `rangeFromOffsets` walks the same text nodes in the
  // same order `textContent` concatenates them, so the offsets line up.
  return chooseAndRange(occurrencesIn(root, root.textContent ?? "", exact, sel), exact.length);
}

function resolveQuote(sel: TextQuoteSelector, root: Element): Range | null {
  if (sel.exact.length === 0) return null;
  const raw = resolveExact(sel.exact, sel, root);
  if (raw) return raw;

  // A selection that ran to a block boundary often captures trailing/leading
  // whitespace (a triple-clicked heading stores "Title\n"); that newline has no
  // counterpart in a block's textContent, nor anywhere if the render has no
  // inter-block whitespace text node — so the raw quote orphans. Retry on the
  // trimmed text, anchoring to the real content the user meant.
  const trimmed = sel.exact.trim();
  if (trimmed && trimmed !== sel.exact) return resolveExact(trimmed, sel, root);
  return null;
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
