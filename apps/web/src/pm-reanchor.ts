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
