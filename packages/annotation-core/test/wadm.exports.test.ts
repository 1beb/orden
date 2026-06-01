import { describe, it, expect } from "vitest";
import {
  createOrdenAnnotation,
  resolveSelectors,
  sourceHash,
  contentHash,
  migrateLegacyDoc,
} from "../src/index";

describe("public surface", () => {
  it("re-exports the WADM foundation", () => {
    expect(typeof createOrdenAnnotation).toBe("function");
    expect(typeof resolveSelectors).toBe("function");
    expect(typeof sourceHash).toBe("function");
    expect(typeof contentHash).toBe("function");
    expect(typeof migrateLegacyDoc).toBe("function");
  });
});
