import { describe, it, expect } from "vitest";
import { createAnnotation } from "../src/annotation";

describe("createAnnotation", () => {
  it("creates an open, agent-targeted annotation with an id", () => {
    const a = createAnnotation({
      anchor: { blockId: "b1" },
      body: "tighten this paragraph",
    });
    expect(a.id).toMatch(/.+/);
    expect(a.target).toBe("agent");
    expect(a.status).toBe("open");
    expect(a.thread).toEqual([]);
    expect(typeof a.createdAt).toBe("string");
  });

  it("honors an explicit human target", () => {
    const a = createAnnotation({
      anchor: { blockId: "b1" },
      body: "share with Sam",
      target: "human",
    });
    expect(a.target).toBe("human");
  });
});
