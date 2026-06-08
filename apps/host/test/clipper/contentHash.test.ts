import { describe, it, expect } from "vitest";
import { contentHash } from "../../src/clipper/contentHash";

describe("contentHash", () => {
  it("is stable and hex, 64 chars (sha256)", () => {
    const h = contentHash("<p>hello</p>");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(contentHash("<p>hello</p>")).toBe(h);
  });
  it("differs for different bytes", () => {
    expect(contentHash("a")).not.toBe(contentHash("b"));
  });
});
