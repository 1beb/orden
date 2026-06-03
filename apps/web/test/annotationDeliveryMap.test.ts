import { describe, it, expect } from "vitest";
import { createOrdenAnnotation } from "@orden/annotation-core";
import type { Source } from "@orden/annotation-core";
import { toAnnotationSendInput } from "../src/annotationDeliveryMap";

describe("toAnnotationSendInput", () => {
  const source: Source = {
    kind: "file",
    vaultPath: "src/foo.ts",
    contentHash: "h1",
  };

  const textAnn = createOrdenAnnotation({
    source,
    selector: {
      type: "text-quote",
      exact: "const x = 1",
      prefix: "",
      suffix: "",
      blockId: "blk-7",
    },
    body: { text: "rename this" },
    creator: { kind: "human", id: "u1" },
  });

  const regionAnn = createOrdenAnnotation({
    source,
    selector: {
      type: "region",
      rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
    },
    body: { text: "look here" },
    creator: { kind: "human", id: "u1" },
  });

  it("uses the file source vaultPath as planDoc", () => {
    const input = toAnnotationSendInput(source, [textAnn, regionAnn]);
    expect(input.planDoc).toBe("src/foo.ts");
    expect(input.annotations).toHaveLength(2);
  });

  it("maps a text-quote annotation with quote + blockId", () => {
    const input = toAnnotationSendInput(source, [textAnn]);
    const ref = input.annotations[0];
    expect(ref.id).toBe(textAnn.id);
    expect(ref.planDoc).toBe("src/foo.ts");
    expect(ref.note).toBe("rename this");
    expect(ref.quote).toBe("const x = 1");
    expect(ref.blockId).toBe("blk-7");
  });

  it("maps a region annotation with no quote and no blockId", () => {
    const input = toAnnotationSendInput(source, [regionAnn]);
    const ref = input.annotations[0];
    expect(ref.id).toBe(regionAnn.id);
    expect(ref.note).toBe("look here");
    expect(ref.quote).toBeUndefined();
    expect(ref.blockId).toBeUndefined();
  });

  it("uses url as planDoc for a web source", () => {
    const web: Source = {
      kind: "web",
      url: "https://example.com/p",
      snapshotPath: "snap/1.html",
      contentHash: "h2",
    };
    const ann = createOrdenAnnotation({
      source: web,
      selector: { type: "text-quote", exact: "hi", prefix: "", suffix: "" },
      body: { text: "n" },
      creator: { kind: "human", id: "u1" },
    });
    const input = toAnnotationSendInput(web, [ann]);
    expect(input.planDoc).toBe("https://example.com/p");
    expect(input.annotations[0].planDoc).toBe("https://example.com/p");
  });
});
