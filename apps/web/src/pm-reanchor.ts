import type { Node as PMNode } from "prosemirror-model";
import type { TextPositionSelector, TextQuoteSelector } from "@orden/annotation-core";

// Cold-start re-anchoring on the ProseMirror document: find a stored quote and
// return its range, using the same context-disambiguation rule as the core's
// resolveAnchor — unambiguous match wins, otherwise null (orphan), never a guess.
// When context scores tie, the stored document position (if available) breaks
// the tie by picking the occurrence closest to the original annotation position.
// Offset→position mapping assumes prose textblocks (no inline atom nodes), which
// holds for the markdown content here.

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

// A selection can start in one textblock and end in another (e.g. dragged from a
// paragraph into a following code block). addAnnotation captures such a quote with
// doc.textBetween, which concatenates the blocks' text with no separator — so the
// quote exists in no single textblock and a per-block search orphans it. This
// searches the document as one concatenated text run (matching how capture joined
// it) and maps the hit's offsets back to ProseMirror positions. addMark spans the
// intervening block boundaries on its own, so only the start/end need mapping.
function reanchorCrossBlock(
  doc: PMNode,
  quote: TextQuoteSelector,
): { from: number; to: number; score: number }[] {
  const blocks: { start: number; pos: number; len: number }[] = [];
  let concat = "";
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    blocks.push({ start: concat.length, pos, len: node.textContent.length });
    concat += node.textContent;
    return false;
  });

  // Map a concat offset to a ProseMirror position. `atEnd` picks the block that
  // *ends* at a boundary offset (exclusive end), so a hit ending exactly at a
  // block's last char maps to that block, not the start of the next one.
  const toPos = (offset: number, atEnd: boolean): number | null => {
    for (const b of blocks) {
      const end = b.start + b.len;
      const inside = atEnd ? offset > b.start && offset <= end : offset >= b.start && offset < end;
      if (inside) return b.pos + 1 + (offset - b.start);
    }
    return null;
  };

  const occ: { from: number; to: number; score: number }[] = [];
  let i = concat.indexOf(quote.exact);
  while (i !== -1) {
    const from = toPos(i, false);
    const to = toPos(i + quote.exact.length, true);
    if (from !== null && to !== null) {
      const before = concat.slice(0, i);
      const after = concat.slice(i + quote.exact.length);
      const score =
        commonSuffixLength(before, quote.prefix) + commonPrefixLength(after, quote.suffix);
      occ.push({ from, to, score });
    }
    i = concat.indexOf(quote.exact, i + 1);
  }
  return occ;
}

export function reanchorQuote(
  doc: PMNode,
  quote: TextQuoteSelector,
  position?: TextPositionSelector,
): { from: number; to: number } | null {
  if (!quote.exact) return null;

  const occ: { from: number; to: number; score: number }[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    const text = node.textContent;
    let i = text.indexOf(quote.exact);
    while (i !== -1) {
      const before = text.slice(0, i);
      const after = text.slice(i + quote.exact.length);
      const score =
        commonSuffixLength(before, quote.prefix) + commonPrefixLength(after, quote.suffix);
      occ.push({ from: pos + 1 + i, to: pos + 1 + i + quote.exact.length, score });
      i = text.indexOf(quote.exact, i + 1);
    }
    return false;
  });

  // No single textblock held the quote — try spanning block boundaries.
  if (occ.length === 0) occ.push(...reanchorCrossBlock(doc, quote));

  if (occ.length === 0) return null;
  if (occ.length === 1) return { from: occ[0].from, to: occ[0].to };
  const max = Math.max(...occ.map((o) => o.score));
  const top = occ.filter((o) => o.score === max);
  if (top.length === 1) return { from: top[0].from, to: top[0].to };

  // Tie-break by proximity to the stored document position (when available).
  if (position) {
    const best = top.reduce((a, b) =>
      Math.abs(a.from - position.start) < Math.abs(b.from - position.start) ? a : b,
    );
    return { from: best.from, to: best.to };
  }

  return null;
}
