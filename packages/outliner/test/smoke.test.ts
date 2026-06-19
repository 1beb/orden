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
  });

  it("no longer carries orden lane/policy constants (moved to @orden/host-api)", () => {
    // The outliner is a generic primitive: LIFECYCLE_ORDER / NEEDS_ACTION_STATES /
    // COMPLETE_TTL_MS / isExpiredComplete / CardState were orden board policy and
    // moved out. None should be reachable from the barrel.
    expect((outliner as Record<string, unknown>).LIFECYCLE_ORDER).toBeUndefined();
    expect((outliner as Record<string, unknown>).CardState).toBeUndefined();
    expect((outliner as Record<string, unknown>).isExpiredComplete).toBeUndefined();
  });
});
