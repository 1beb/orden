import { describe, it, expect } from "vitest";
import { buildWebAnnotations, type RawHighlight } from "../../src/clipper/buildWebAnnotations";
import type { Source } from "@orden/annotation-core";

const source: Source = { kind: "web", url: "https://x.test/a", snapshotPath: "snapshots/h.html", contentHash: "h", title: "A" };

function raw(over: Partial<RawHighlight> = {}): RawHighlight {
  return { exact: "the server mints", prefix: "...", suffix: "...", blockId: "b1", note: "n", audience: "agent", ...over };
}

describe("buildWebAnnotations", () => {
  it("produces a WADM OrdenAnnotation per highlight, with a text-quote selector carrying blockId", () => {
    const [a] = buildWebAnnotations(source, [raw()], () => "id-1", () => "2026-06-08T00:00:00Z");
    expect(a.target.source).toEqual(source);
    expect(a.target.selector).toMatchObject({ type: "text-quote", exact: "the server mints", blockId: "b1" });
    expect(a.body.text).toBe("n");
    expect(a["orden:audience"]).toBe("agent");
    expect(a["orden:status"]).toBe("open");
    expect(a.creator.kind).toBe("human");
  });
  it("carries a per-highlight screenshot path under an orden: field when present", () => {
    const [a] = buildWebAnnotations(source, [raw({ shot: "snapshots/h-0.webp" })], () => "id", () => "t");
    expect(a["orden:shot"]).toBe("snapshots/h-0.webp");
  });
  it("maps a for-me highlight to human audience", () => {
    const [a] = buildWebAnnotations(source, [raw({ audience: "human" })], () => "id", () => "t");
    expect(a["orden:audience"]).toBe("human");
  });
});
