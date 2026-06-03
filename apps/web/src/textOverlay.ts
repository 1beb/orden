import { resolveSelectors, type OrdenAnnotation } from "@orden/annotation-core";

// The CSS Custom Highlight API is not in the TS `DOM` lib shipped here, so it's
// declared minimally and locally rather than loosening types globally. happy-dom
// also lacks it at runtime, which is why painting is feature-guarded below.
type HighlightCtor = { new (...ranges: Range[]): unknown };
interface CSSWithHighlights {
  highlights?: Map<string, unknown>;
}
// A realm exposes its OWN Highlight constructor and CSS.highlights registry. A
// Highlight built in the parent realm can't hold an iframe's ranges, so painting
// must use the constructor from the same Window the ranges belong to.
interface HighlightRealm {
  Highlight?: HighlightCtor;
  CSS?: CSSWithHighlights;
}

const realmDefault = (): Window =>
  globalThis as unknown as Window;

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
// Checked per-realm so an iframe and the parent are guarded independently.
function highlightsSupported(win: Window): boolean {
  const realm = win as unknown as HighlightRealm;
  return (
    typeof realm.Highlight !== "undefined" &&
    typeof realm.CSS !== "undefined" &&
    !!realm.CSS.highlights
  );
}

function realmOf(win: Window): { ctor: HighlightCtor; highlights: Map<string, unknown> } {
  const realm = win as unknown as HighlightRealm;
  return { ctor: realm.Highlight!, highlights: realm.CSS!.highlights! };
}

const HL = "orden-annotation";
const HL_ACTIVE = "orden-annotation-active";

// Paint stored annotations as CSS Custom Highlights over `root` (no DOM mutation).
// Returns the placed ranges so callers can map id -> range (e.g. scroll-to).
// No-ops the paint where the API is unavailable, but still returns the ranges.
// `win` selects the realm; for an iframe pass its contentWindow so the Highlight
// constructor and CSS.highlights registry come from the same realm as the ranges.
export function paintHighlights(
  root: Element,
  anns: OrdenAnnotation[],
  win: Window = realmDefault(),
): PlacedRange[] {
  const placed = resolveAnnotationRanges(anns, root);
  if (!highlightsSupported(win)) return placed;
  const { ctor, highlights } = realmOf(win);
  const hl = new ctor(...placed.map((p) => p.range));
  highlights.set(HL, hl);
  return placed;
}

// Emphasise a single annotation's range (hover/active linking with the panel).
export function setActiveHighlight(range: Range | null, win: Window = realmDefault()): void {
  if (!highlightsSupported(win)) return;
  const { ctor, highlights } = realmOf(win);
  if (range) highlights.set(HL_ACTIVE, new ctor(range));
  else highlights.delete(HL_ACTIVE);
}

// Remove all orden highlights (call when leaving a text view so they don't leak).
export function clearHighlights(win: Window = realmDefault()): void {
  if (!highlightsSupported(win)) return;
  const { highlights } = realmOf(win);
  highlights.delete(HL);
  highlights.delete(HL_ACTIVE);
}

// Inject the ::highlight() rules into a document's <head>. The parent document
// gets these from the app stylesheet, but an iframe document doesn't load it, so
// callers ensure them for the iframe realm before painting. Idempotent.
export function ensureHighlightStyles(doc: Document): void {
  if (doc.head.querySelector("style[data-orden-highlights]")) return;
  const style = doc.createElement("style");
  style.setAttribute("data-orden-highlights", "");
  style.textContent = `::highlight(${HL}){background:color-mix(in srgb, var(--accent, #6d28d9) 22%, transparent);}::highlight(${HL_ACTIVE}){background:color-mix(in srgb, var(--accent, #6d28d9) 40%, transparent);}`;
  doc.head.appendChild(style);
}
