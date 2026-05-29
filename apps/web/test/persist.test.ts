import { beforeEach, describe, expect, it } from "vitest";
import { createAnnotation, type Annotation } from "@orden/annotation-core";
import { clearState, loadState, saveState } from "../src/persist";

function makeRecord(body: string): Annotation {
  return createAnnotation({
    anchor: { blockId: "b1", position: { start: 0, end: 4 } },
    body,
  });
}

describe("persist", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns null when nothing is stored", () => {
    expect(loadState("doc-a")).toBeNull();
  });

  it("round-trips markdown and records", () => {
    const records = [makeRecord("first"), makeRecord("second")];
    saveState("doc-a", "# Hello\n\nworld", records);

    const loaded = loadState("doc-a");
    expect(loaded).not.toBeNull();
    expect(loaded!.markdown).toBe("# Hello\n\nworld");
    expect(loaded!.records).toEqual(records);
  });

  it("stores under the orden:doc:<docKey> key", () => {
    saveState("doc-a", "x", []);
    expect(localStorage.getItem("orden:doc:doc-a")).not.toBeNull();
  });

  it("keeps different docKeys independent", () => {
    saveState("doc-a", "alpha", [makeRecord("a")]);
    saveState("doc-b", "beta", []);

    expect(loadState("doc-a")!.markdown).toBe("alpha");
    expect(loadState("doc-a")!.records).toHaveLength(1);
    expect(loadState("doc-b")!.markdown).toBe("beta");
    expect(loadState("doc-b")!.records).toHaveLength(0);
  });

  it("returns null for malformed JSON without throwing", () => {
    localStorage.setItem("orden:doc:doc-a", "{ not valid json");
    expect(() => loadState("doc-a")).not.toThrow();
    expect(loadState("doc-a")).toBeNull();
  });

  it("clears stored state", () => {
    saveState("doc-a", "x", []);
    expect(loadState("doc-a")).not.toBeNull();

    clearState("doc-a");
    expect(loadState("doc-a")).toBeNull();
    expect(localStorage.getItem("orden:doc:doc-a")).toBeNull();
  });
});
