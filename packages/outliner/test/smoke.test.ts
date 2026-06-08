import { describe, it, expect } from "vitest";
import * as outliner from "../src/index";

describe("package barrel", () => {
  it("exports the core surface", () => {
    expect(typeof outliner.createRoot).toBe("function");
    expect(typeof outliner.toMarkdown).toBe("function");
    expect(typeof outliner.extractLinks).toBe("function");
    expect(typeof outliner.buildBacklinkIndex).toBe("function");
    expect(typeof outliner.buildBoard).toBe("function");
    expect(typeof outliner.renderBoard).toBe("function");
    expect(outliner.LIFECYCLE_ORDER.length).toBe(4);
  });
});
