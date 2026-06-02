import { describe, it, expect } from "vitest";
import type { Annotation } from "../src/types";
import { migrateLegacyDoc } from "../src/migrate";

const legacy: Annotation[] = [
  {
    id: "ann_old_1",
    anchor: { blockId: "b1", quote: { exact: "quick", prefix: "the ", suffix: " brown" }, position: { start: 4, end: 9 } },
    body: "tighten this",
    target: "human",
    status: "sent",
    thread: [{ author: "agent", body: "ok", createdAt: "2026-05-01T00:00:00.000Z" }],
    createdAt: "2026-05-01T00:00:00.000Z",
  },
];

describe("migrateLegacyDoc", () => {
  it("produces a file source bundle keyed by vaultPath", () => {
    const bundle = migrateLegacyDoc({
      vaultPath: "notes/x.md",
      contentHash: "sha256:aa",
      records: legacy,
    });
    expect(bundle.source).toEqual({ kind: "file", vaultPath: "notes/x.md", contentHash: "sha256:aa" });
    expect(bundle.annotations).toHaveLength(1);
  });

  it("maps anchor to a [text-quote, text-position] selector fallback array", () => {
    const { annotations } = migrateLegacyDoc({ vaultPath: "notes/x.md", contentHash: "sha256:aa", records: legacy });
    const sel = annotations[0].target.selector;
    expect(Array.isArray(sel)).toBe(true);
    const arr = sel as any[];
    expect(arr[0]).toMatchObject({ type: "text-quote", exact: "quick", prefix: "the ", suffix: " brown", blockId: "b1" });
    expect(arr[1]).toMatchObject({ type: "text-position", start: 4, end: 9, blockId: "b1" });
  });

  it("preserves id, body, audience, status, thread, created", () => {
    const a = migrateLegacyDoc({ vaultPath: "notes/x.md", contentHash: "sha256:aa", records: legacy }).annotations[0];
    expect(a.id).toBe("ann_old_1");
    expect(a.body.text).toBe("tighten this");
    expect(a["orden:audience"]).toBe("human");
    expect(a["orden:status"]).toBe("sent");
    expect(a["orden:thread"]).toHaveLength(1);
    expect(a.created).toBe("2026-05-01T00:00:00.000Z");
  });

  it("omits a selector variant when its source anchor field is absent", () => {
    const quoteOnly: Annotation[] = [{ ...legacy[0], anchor: { blockId: "b1", quote: { exact: "x", prefix: "", suffix: "" } } }];
    const a = migrateLegacyDoc({ vaultPath: "n.md", contentHash: "sha256:bb", records: quoteOnly }).annotations[0];
    const arr = a.target.selector as any[];
    expect(arr).toHaveLength(1);
    expect(arr[0].type).toBe("text-quote");
  });
});
