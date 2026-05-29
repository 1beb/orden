import { beforeEach, describe, expect, it } from "vitest";
import { createAnnotation, type Annotation } from "@orden/annotation-core";
import { BrowserHost } from "../src/host/browserHost";
import { clearState, hydrateDocs, loadState, saveState } from "../src/persist";

function makeRecord(body: string): Annotation {
  return createAnnotation({
    anchor: { blockId: "b1", position: { start: 0, end: 4 } },
    body,
  });
}

// Per-doc state lives in the vault (ns "docs"). Hydrated into a cache at boot
// so loadState/saveState stay synchronous; writes write through to the vault.
describe("persist (host-backed)", () => {
  beforeEach(async () => {
    localStorage.clear();
    await hydrateDocs(new BrowserHost());
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

  it("keeps different docKeys independent", () => {
    saveState("doc-a", "alpha", [makeRecord("a")]);
    saveState("doc-b", "beta", []);

    expect(loadState("doc-a")!.markdown).toBe("alpha");
    expect(loadState("doc-a")!.records).toHaveLength(1);
    expect(loadState("doc-b")!.markdown).toBe("beta");
    expect(loadState("doc-b")!.records).toHaveLength(0);
  });

  it("persists across a re-hydrate (fresh host over the same vault)", async () => {
    saveState("doc-a", "alpha", [makeRecord("a")]);
    await new Promise((r) => setTimeout(r, 10)); // let the write-through settle
    await hydrateDocs(new BrowserHost());
    expect(loadState("doc-a")!.markdown).toBe("alpha");
  });

  it("clears stored state", async () => {
    saveState("doc-a", "x", []);
    expect(loadState("doc-a")).not.toBeNull();

    clearState("doc-a");
    expect(loadState("doc-a")).toBeNull();
    await hydrateDocs(new BrowserHost());
    expect(loadState("doc-a")).toBeNull();
  });
});
