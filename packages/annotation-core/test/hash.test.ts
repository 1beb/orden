import { describe, it, expect } from "vitest";
import { sourceHash, contentHash } from "../src/hash";

describe("sourceHash", () => {
  it("keys a web source by url, file source by vaultPath", () => {
    const web = sourceHash({ kind: "web", url: "https://a.com/x", snapshotPath: "s", contentHash: "sha256:z" });
    const file = sourceHash({ kind: "file", vaultPath: "notes/x.md", contentHash: "sha256:z" });
    expect(web).toMatch(/^[a-z0-9]+$/); // filename-safe base36
    expect(file).toMatch(/^[a-z0-9]+$/);
    expect(web).not.toBe(file);
  });

  it("is stable for the same identity regardless of contentHash/title", () => {
    const a = sourceHash({ kind: "web", url: "https://a.com/x", snapshotPath: "s1", contentHash: "sha256:1", title: "A" });
    const b = sourceHash({ kind: "web", url: "https://a.com/x", snapshotPath: "s2", contentHash: "sha256:2", title: "B" });
    expect(a).toBe(b);
  });
});

describe("contentHash", () => {
  it("returns a sha256:-prefixed hex digest", async () => {
    const h = await contentHash("hello");
    expect(h).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("is deterministic and content-sensitive", async () => {
    expect(await contentHash("a")).toBe(await contentHash("a"));
    expect(await contentHash("a")).not.toBe(await contentHash("b"));
  });
});
