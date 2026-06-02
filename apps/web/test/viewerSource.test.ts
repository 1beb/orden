import { describe, it, expect } from "vitest";
import { fileSource } from "../src/viewerSource";

describe("fileSource", () => {
  it("builds a file source with a sha256 content hash from text", async () => {
    const s = await fileSource("docs/a.ts", "hello", "A");
    expect(s.kind).toBe("file");
    expect(s).toMatchObject({ vaultPath: "docs/a.ts", title: "A" });
    expect(s.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("is content-sensitive (drift detectable)", async () => {
    const a = await fileSource("docs/a.ts", "v1");
    const b = await fileSource("docs/a.ts", "v2");
    expect(a.contentHash).not.toBe(b.contentHash);
  });
});
