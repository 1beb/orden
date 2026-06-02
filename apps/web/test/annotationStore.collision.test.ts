import { describe, it, expect, vi, beforeEach } from "vitest";
import type { VaultStore } from "@orden/host-api";
import type { OrdenAnnotation, Source } from "@orden/annotation-core";

// Force every source to hash to the SAME key so two distinct sources genuinely
// collide in the store's cache/vault. This exercises the identity guard's
// primary purpose, which the non-colliding tests can't reach (different paths
// normally produce different keys, so the guard is never consulted there).
vi.mock("@orden/annotation-core", async (orig) => {
  const actual = await orig<typeof import("@orden/annotation-core")>();
  return { ...actual, sourceHash: () => "COLLIDE" };
});

const { AnnotationStore } = await import("../src/annotationStore");

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

const a: Source = { kind: "file", vaultPath: "x/a.ts", contentHash: "sha256:aa" };
const b: Source = { kind: "file", vaultPath: "y/b.ts", contentHash: "sha256:bb" };
function ann(id: string, source: Source): OrdenAnnotation {
  return {
    id, created: "2026-06-02T00:00:00.000Z", creator: { kind: "human", id: "me" },
    target: { source, selector: { type: "text-quote", exact: "x", prefix: "", suffix: "" } },
    body: { text: "note" }, "orden:status": "open", "orden:audience": "agent", "orden:thread": [],
  };
}

describe("AnnotationStore under a forced sourceHash collision", () => {
  let store: InstanceType<typeof AnnotationStore>;
  beforeEach(async () => {
    store = new AnnotationStore(fakeVault());
    await store.hydrate();
  });

  it("does not return source A's annotations for the colliding source B", () => {
    store.add(a, ann("a1", a));
    // Same cache key as A, but a different identity -> guard must return [].
    expect(store.forSource(b)).toEqual([]);
  });

  it("does not merge B's add into A's bundle; B replaces the slot with its own", () => {
    store.add(a, ann("a1", a));
    store.add(b, ann("b1", b));
    // add(b) saw a non-matching stored source, so it started a fresh bundle for B.
    expect(store.forSource(b).map((x) => x.id)).toEqual(["b1"]);
    // A now reads through the same key but no longer matches identity -> [].
    expect(store.forSource(a)).toEqual([]);
  });
});
