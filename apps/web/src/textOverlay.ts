import { resolveSelectors, type OrdenAnnotation } from "@orden/annotation-core";

// The CSS Custom Highlight API is not in the TS `DOM` lib shipped here, so it's
// declared minimally and locally rather than loosening types globally. happy-dom
// also lacks it at runtime, which is why painting is feature-guarded below.
declare const Highlight: { new (...ranges: Range[]): unknown };
interface CSSWithHighlights {
  highlights?: Map<string, unknown>;
}

export interface PlacedRange {
  id: string;
  range: Range;
}

// Resolve each annotation's selector to a DOM Range within `root`. Annotations
// whose anchor no longer resolves (text drifted / removed) are dropped — they're
// orphans, surfaced elsewhere, not painted.
export function resolveAnnotationRanges(anns: OrdenAnnotation[], root: Element): PlacedRange[] {
  const out: PlacedRange[] = [];
  for (const a of anns) {
    const range = resolveSelectors(a.target.selector, root);
    if (range) out.push({ id: a.id, range });
  }
  return out;
}

// Feature flag: the CSS Custom Highlight API. Absent in happy-dom and old browsers.
function highlightsSupported(): boolean {
  return (
    typeof Highlight !== "undefined" &&
    typeof CSS !== "undefined" &&
    !!(CSS as unknown as CSSWithHighlights).highlights
  );
}

function highlights(): Map<string, unknown> {
  return (CSS as unknown as CSSWithHighlights).highlights!;
}

const HL = "orden-annotation";
const HL_ACTIVE = "orden-annotation-active";

// Paint stored annotations as CSS Custom Highlights over `root` (no DOM mutation).
// Returns the placed ranges so callers can map id -> range (e.g. scroll-to).
// No-ops the paint where the API is unavailable, but still returns the ranges.
export function paintHighlights(root: Element, anns: OrdenAnnotation[]): PlacedRange[] {
  const placed = resolveAnnotationRanges(anns, root);
  if (!highlightsSupported()) return placed;
  const hl = new Highlight(...placed.map((p) => p.range));
  highlights().set(HL, hl);
  return placed;
}

// Emphasise a single annotation's range (hover/active linking with the panel).
export function setActiveHighlight(range: Range | null): void {
  if (!highlightsSupported()) return;
  if (range) highlights().set(HL_ACTIVE, new Highlight(range));
  else highlights().delete(HL_ACTIVE);
}

// Remove all orden highlights (call when leaving a text view so they don't leak).
export function clearHighlights(): void {
  if (!highlightsSupported()) return;
  highlights().delete(HL);
  highlights().delete(HL_ACTIVE);
}
