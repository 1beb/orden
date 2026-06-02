import { describe, it, expect } from "vitest";
import type {
  Source,
  Selector,
  OrdenAnnotation,
  AnnotationReply,
} from "../src/wadm";

describe("OrdenAnnotation shape", () => {
  it("accepts a web source with a text-quote selector and orden: superset", () => {
    const reply: AnnotationReply = {
      author: "agent",
      body: "done",
      createdAt: "2026-06-01T00:00:00.000Z",
    };
    const source: Source = {
      kind: "web",
      url: "https://example.com/a",
      snapshotPath: ".orden/snapshots/abc.html",
      contentHash: "sha256:abc",
      title: "Example",
    };
    const selector: Selector = {
      type: "text-quote",
      exact: "quick",
      prefix: "the ",
      suffix: " brown",
    };
    const ann: OrdenAnnotation = {
      id: "ann_1",
      created: "2026-06-01T00:00:00.000Z",
      creator: { kind: "human", id: "me" },
      target: { source, selector },
      body: { text: "note", tags: ["x"], color: "yellow" },
      "orden:status": "open",
      "orden:audience": "agent",
      "orden:thread": [reply],
    };
    expect(ann.target.source.kind).toBe("web");
    const sel = Array.isArray(ann.target.selector)
      ? ann.target.selector[0]
      : ann.target.selector;
    expect(sel.type).toBe("text-quote");
    expect(ann["orden:thread"]).toHaveLength(1);
  });

  it("accepts a file source with a region selector array", () => {
    const ann: OrdenAnnotation = {
      id: "ann_2",
      created: "2026-06-01T00:00:00.000Z",
      creator: { kind: "agent", id: "claude" },
      target: {
        source: { kind: "file", vaultPath: "clips/x.png", contentHash: "sha256:zz" },
        selector: [
          { type: "region", page: 1, rect: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 } },
        ],
      },
      body: { text: "see this area" },
      "orden:status": "open",
      "orden:audience": "human",
      "orden:thread": [],
    };
    const sel = Array.isArray(ann.target.selector)
      ? ann.target.selector[0]
      : ann.target.selector;
    expect(sel.type).toBe("region");
  });
});
