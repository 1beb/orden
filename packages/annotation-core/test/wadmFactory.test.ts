import { describe, it, expect } from "vitest";
import { createOrdenAnnotation } from "../src/wadmFactory";

const source = {
  kind: "file" as const,
  vaultPath: "notes/x.md",
  contentHash: "sha256:aa",
};
const selector = {
  type: "text-quote" as const,
  exact: "hi",
  prefix: "",
  suffix: "",
};

describe("createOrdenAnnotation", () => {
  it("defaults to open status, agent audience, empty thread, human creator", () => {
    const a = createOrdenAnnotation({
      source,
      selector,
      body: { text: "note" },
      creator: { kind: "human", id: "me" },
    });
    expect(a.id).toMatch(/^ann_/);
    expect(a["orden:status"]).toBe("open");
    expect(a["orden:audience"]).toBe("agent");
    expect(a["orden:thread"]).toEqual([]);
    expect(a.creator).toEqual({ kind: "human", id: "me" });
    expect(typeof a.created).toBe("string");
  });

  it("honors an explicit audience", () => {
    const a = createOrdenAnnotation({
      source,
      selector,
      body: { text: "note" },
      creator: { kind: "human", id: "me" },
      audience: "human",
    });
    expect(a["orden:audience"]).toBe("human");
  });

  it("mints unique ids", () => {
    const mk = () =>
      createOrdenAnnotation({ source, selector, body: { text: "n" }, creator: { kind: "human", id: "me" } });
    expect(mk().id).not.toBe(mk().id);
  });
});
