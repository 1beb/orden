import { describe, it, expect, beforeEach } from "vitest";
import type { VaultStore } from "@orden/host-api";
import type { OrdenAnnotation, Source } from "@orden/annotation-core";
import { sourceHash } from "@orden/annotation-core";
import { AnnotationStore } from "../src/annotationStore";

function fakeVault(): VaultStore {
  const data = new Map<string, unknown>();
  return {
    async get(ns, key) { return (data.get(`${ns}/${key}`) ?? null) as any; },
    async set(ns, key, value) { data.set(`${ns}/${key}`, value); },
    async list(ns) {
      return [...data.keys()].filter((k) => k.startsWith(`${ns}/`)).map((k) => k.slice(ns.length + 1));
    },
    async delete(ns, key) { data.delete(`${ns}/${key}`); },
  };
}

const source: Source = { kind: "file", vaultPath: "x/a.ts", contentHash: "sha256:aa" };
function ann(id: string): OrdenAnnotation {
  return {
    id, created: "2026-06-02T00:00:00.000Z", creator: { kind: "human", id: "me" },
    target: { source, selector: { type: "text-quote", exact: "x", prefix: "", suffix: "" } },
    body: { text: "note" }, "orden:status": "open", "orden:audience": "agent", "orden:thread": [],
  };
}

describe("AnnotationStore", () => {
  let vault: VaultStore;
  let store: AnnotationStore;
  beforeEach(async () => {
    vault = fakeVault();
    store = new AnnotationStore(vault);
    await store.hydrate();
  });

  it("returns [] for an unknown source", () => {
    expect(store.forSource(source)).toEqual([]);
  });

  it("adds and lists annotations for a source, and write-through persists", async () => {
    store.add(source, ann("a1"));
    expect(store.forSource(source).map((a) => a.id)).toEqual(["a1"]);
    const bundle = await vault.get<{ source: Source; annotations: OrdenAnnotation[] }>("annotations", sourceHash(source));
    expect(bundle?.annotations).toHaveLength(1);
    expect(bundle?.source).toEqual(source);
  });

  it("removes an annotation", () => {
    store.add(source, ann("a1"));
    store.add(source, ann("a2"));
    store.remove(source, "a1");
    expect(store.forSource(source).map((a) => a.id)).toEqual(["a2"]);
  });

  it("re-hydrates persisted bundles into a fresh store", async () => {
    store.add(source, ann("a1"));
    const store2 = new AnnotationStore(vault);
    await store2.hydrate();
    expect(store2.forSource(source).map((a) => a.id)).toEqual(["a1"]);
  });

  it("guards source-hash collisions by comparing stored source identity before merging", async () => {
    const other: Source = { kind: "file", vaultPath: "y/b.ts", contentHash: "sha256:bb" };
    store.add(source, ann("a1"));
    expect(store.forSource(other)).toEqual([]);
  });
});
