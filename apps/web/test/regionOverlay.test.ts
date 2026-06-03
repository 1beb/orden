import { describe, it, expect } from "vitest";
import { normalizeRect, denormalizeRect, renderRegionBoxes, buildRegionAnnotation } from "../src/regionOverlay";
import type { OrdenAnnotation, Source } from "@orden/annotation-core";

describe("region rect normalization", () => {
  it("normalizes a pixel rect to 0-1 against container size", () => {
    expect(normalizeRect({ x: 50, y: 20, w: 100, h: 40 }, { w: 200, h: 80 }))
      .toEqual({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
  });
  it("round-trips", () => {
    const norm = { x: 0.1, y: 0.2, w: 0.3, h: 0.4 };
    const px = denormalizeRect(norm, { w: 1000, h: 500 });
    expect(normalizeRect(px, { w: 1000, h: 500 })).toEqual(norm);
  });
  it("clamps a drag that runs past the edges into 0..1", () => {
    const n = normalizeRect({ x: -10, y: -10, w: 9999, h: 9999 }, { w: 100, h: 100 });
    expect(n.x).toBe(0); expect(n.y).toBe(0);
    expect(n.x + n.w).toBeLessThanOrEqual(1);
    expect(n.y + n.h).toBeLessThanOrEqual(1);
  });
});

const SRC: Source = { kind: "file", vaultPath: "a.png", contentHash: "h" };

function regionAnn(rect: { x: number; y: number; w: number; h: number }, id = "r1"): OrdenAnnotation {
  return {
    id,
    created: new Date().toISOString(),
    creator: { kind: "human", id: "me" },
    target: { source: SRC, selector: { type: "region", rect } },
    body: { text: "note" },
    "orden:status": "open",
    "orden:audience": "agent",
    "orden:thread": [],
  };
}

describe("renderRegionBoxes", () => {
  it("renders one box positioned via denormalizeRect", () => {
    const layer = document.createElement("div");
    const ann = regionAnn({ x: 0.25, y: 0.5, w: 0.5, h: 0.25 });
    renderRegionBoxes(layer, [ann], { w: 200, h: 100 }, {});
    const boxes = layer.querySelectorAll(".region-box");
    expect(boxes.length).toBe(1);
    const box = boxes[0] as HTMLElement;
    expect(box.dataset.annotationId).toBe("r1");
    expect(box.style.left).toBe("50px");
    expect(box.style.top).toBe("50px");
    expect(box.style.width).toBe("100px");
    expect(box.style.height).toBe("25px");
  });

  it("marks the active box and fires onSelect on click", () => {
    const layer = document.createElement("div");
    const ann = regionAnn({ x: 0, y: 0, w: 0.5, h: 0.5 });
    let picked: string | null = null;
    renderRegionBoxes(layer, [ann], { w: 100, h: 100 }, {
      activeId: "r1",
      onSelect: (id) => { picked = id; },
    });
    const box = layer.querySelector(".region-box") as HTMLElement;
    expect(box.classList.contains("is-active")).toBe(true);
    box.click();
    expect(picked).toBe("r1");
  });

  it("ignores annotations without a region selector", () => {
    const layer = document.createElement("div");
    const textAnn: OrdenAnnotation = {
      ...regionAnn({ x: 0, y: 0, w: 1, h: 1 }, "t1"),
      target: { source: SRC, selector: { type: "text-quote", exact: "x", prefix: "", suffix: "" } },
    };
    renderRegionBoxes(layer, [textAnn], { w: 100, h: 100 }, {});
    expect(layer.querySelectorAll(".region-box").length).toBe(0);
  });

  it("finds a region selector inside a selector array", () => {
    const layer = document.createElement("div");
    const ann: OrdenAnnotation = {
      ...regionAnn({ x: 0, y: 0, w: 0.5, h: 0.5 }, "a1"),
      target: {
        source: SRC,
        selector: [
          { type: "text-quote", exact: "x", prefix: "", suffix: "" },
          { type: "region", rect: { x: 0, y: 0, w: 0.5, h: 0.5 } },
        ],
      },
    };
    renderRegionBoxes(layer, [ann], { w: 100, h: 100 }, {});
    expect(layer.querySelectorAll(".region-box").length).toBe(1);
  });
});

describe("buildRegionAnnotation", () => {
  it("builds an annotation with a region selector and the note as body text", () => {
    const ann = buildRegionAnnotation({
      source: SRC,
      rect: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
      note: "look here",
      creator: { kind: "human", id: "me" },
    });
    expect(ann.target.selector).toEqual({ type: "region", rect: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 } });
    expect(ann.body.text).toBe("look here");
    expect(ann["orden:status"]).toBe("open");
    expect(ann.creator).toEqual({ kind: "human", id: "me" });
  });

  it("honors the audience override", () => {
    const ann = buildRegionAnnotation({
      source: SRC,
      rect: { x: 0, y: 0, w: 1, h: 1 },
      note: "n",
      creator: { kind: "human", id: "me" },
      audience: "human",
    });
    expect(ann["orden:audience"]).toBe("human");
  });
});
