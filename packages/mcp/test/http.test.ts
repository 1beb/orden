import { describe, it, expect } from "vitest";
import { parseSessionBinding } from "../src/http";

describe("parseSessionBinding", () => {
  it("returns the path id for /mcp/<id>", () => {
    expect(parseSessionBinding({ url: "/mcp/abc-123", headers: {} })).toBe("abc-123");
  });

  it("prefers the x-orden-session header over the path", () => {
    expect(
      parseSessionBinding({ url: "/mcp/abc-123", headers: { "x-orden-session": "hdr" } }),
    ).toBe("hdr");
  });

  it("returns undefined for a bare /mcp", () => {
    expect(parseSessionBinding({ url: "/mcp", headers: {} })).toBeUndefined();
  });

  it("returns undefined when there is no url and no header", () => {
    expect(parseSessionBinding({ headers: {} })).toBeUndefined();
  });

  it("strips a query string from the path id", () => {
    expect(parseSessionBinding({ url: "/mcp/abc?x=1", headers: {} })).toBe("abc");
  });

  it("decodes a percent-encoded path id", () => {
    expect(parseSessionBinding({ url: "/mcp/a%20b", headers: {} })).toBe("a b");
  });
});
