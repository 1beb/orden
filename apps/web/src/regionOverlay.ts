// Region (rectangle) annotations for image viewers.
//
// Rect math is pure and resolution-independent: stored region selectors carry a
// normalized 0..1 rect so the same anchor survives any displayed image size.
// `renderRegionBoxes` paints those rects back into pixel-positioned overlay boxes
// over the displayed image, and `buildRegionAnnotation` mints the stored record.

import {
  createOrdenAnnotation,
  type OrdenAnnotation,
  type OrdenAudience,
  type Selector,
  type Source,
} from "@orden/annotation-core";

export interface PxRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Size {
  w: number;
  h: number;
}

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

// Pixel rect -> normalized 0..1 against the container size, clamped so the box
// stays inside [0,1] even when the drag ran past the image edges.
export function normalizeRect(px: PxRect, size: Size): PxRect {
  const x = clamp01(px.x / size.w);
  const y = clamp01(px.y / size.h);
  let w = px.w / size.w;
  let h = px.h / size.h;
  if (w < 0) w = 0;
  if (h < 0) h = 0;
  if (x + w > 1) w = 1 - x;
  if (y + h > 1) h = 1 - y;
  return { x, y, w, h };
}

// Normalized 0..1 rect -> pixel rect at the given displayed size.
export function denormalizeRect(norm: PxRect, size: Size): PxRect {
  return {
    x: norm.x * size.w,
    y: norm.y * size.h,
    w: norm.w * size.w,
    h: norm.h * size.h,
  };
}

// The first region selector on an annotation, or null if it has none.
function regionOf(ann: OrdenAnnotation): { rect: PxRect } | null {
  const selectors: Selector[] = Array.isArray(ann.target.selector)
    ? ann.target.selector
    : [ann.target.selector];
  const region = selectors.find((s) => s.type === "region");
  return region && region.type === "region" ? { rect: region.rect } : null;
}

// Clear `layer` and paint one absolutely-positioned `.region-box` per region
// annotation, positioned by denormalizing its rect against the displayed size.
export function renderRegionBoxes(
  layer: HTMLElement,
  anns: OrdenAnnotation[],
  size: Size,
  opts: { onSelect?: (id: string) => void; activeId?: string | null },
): void {
  layer.replaceChildren();
  for (const ann of anns) {
    const region = regionOf(ann);
    if (!region) continue;
    const px = denormalizeRect(region.rect, size);
    const box = document.createElement("div");
    box.className = "region-box";
    box.dataset.annotationId = ann.id;
    box.style.position = "absolute";
    box.style.left = `${px.x}px`;
    box.style.top = `${px.y}px`;
    box.style.width = `${px.w}px`;
    box.style.height = `${px.h}px`;
    if (ann.id === opts.activeId) box.classList.add("is-active");
    box.addEventListener("click", (e) => {
      e.stopPropagation();
      opts.onSelect?.(ann.id);
    });
    layer.append(box);
  }
}

// Mint a stored region annotation from a normalized rect + a note.
export function buildRegionAnnotation(input: {
  source: Source;
  rect: { x: number; y: number; w: number; h: number };
  note: string;
  creator: { kind: "human" | "agent"; id: string };
  audience?: OrdenAudience;
}): OrdenAnnotation {
  return createOrdenAnnotation({
    source: input.source,
    selector: { type: "region", rect: input.rect },
    body: { text: input.note },
    creator: input.creator,
    audience: input.audience,
  });
}
