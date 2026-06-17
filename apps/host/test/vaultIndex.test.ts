import { describe, it, expect } from "vitest";
import type { VaultStore } from "@orden/host-api";
import { VaultIndex } from "../src/vaultIndex";

function fakeVault(data: Record<string, Record<string, string>>): VaultStore {
  return {
    async get<T>(ns: string, key: string): Promise<T | null> {
      return ((data[ns]?.[key] as unknown) as T) ?? null;
    },
    async set<T>(ns: string, key: string, value: T): Promise<void> {
      (data[ns] ??= {})[key] = value as unknown as string;
    },
    async list(ns: string): Promise<string[]> {
      return Object.keys(data[ns] ?? {});
    },
    async delete(ns: string, key: string): Promise<void> {
      delete data[ns]?.[key];
    },
  };
}

describe("VaultIndex", () => {
  it("opens an in-memory db and returns no hits for an empty index", () => {
    const idx = new VaultIndex(":memory:");
    expect(idx.query("anything")).toEqual([]);
    idx.close();
  });

  it("upserts entries and finds them by body content", () => {
    const idx = new VaultIndex(":memory:");
    idx.upsertEntry("pages", "Design Notes", "- the quick brown fox jumps");
    idx.upsertEntry("pages", "Other", "- nothing relevant here");
    const hits = idx.query("brown");
    expect(hits.map((h) => h.name)).toEqual(["Design Notes"]);
    expect(hits[0].snippet).toContain("brown");
    idx.close();
  });

  it("matches page names too, and re-upsert replaces the old row", () => {
    const idx = new VaultIndex(":memory:");
    idx.upsertEntry("pages", "Roadmap", "- v1 alpha");
    expect(idx.query("roadmap").map((h) => h.name)).toEqual(["Roadmap"]);
    idx.upsertEntry("pages", "Roadmap", "- v2 totally different");
    expect(idx.query("alpha")).toEqual([]); // old body gone
    expect(idx.query("different").map((h) => h.name)).toEqual(["Roadmap"]);
    idx.close();
  });

  it("respects the kinds filter", () => {
    const idx = new VaultIndex(":memory:");
    idx.upsertEntry("pages", "P", "- shared word");
    idx.upsertEntry("journal", "2026-06-17", "- shared word");
    expect(idx.query("shared", { kinds: ["journal"] }).map((h) => h.name)).toEqual(["2026-06-17"]);
    idx.close();
  });

  it("removeEntry drops it from search", () => {
    const idx = new VaultIndex(":memory:");
    idx.upsertEntry("pages", "Gone", "- ephemeral content");
    expect(idx.query("ephemeral")).toHaveLength(1);
    idx.removeEntry("pages", "Gone");
    expect(idx.query("ephemeral")).toEqual([]);
    idx.close();
  });

  it("indexes outgoing links and answers backlinks case-insensitively", () => {
    const idx = new VaultIndex(":memory:");
    idx.upsertEntry("pages", "Source", "- see [[Target]] and [[ target ]] again");
    idx.upsertEntry("journal", "2026-06-17", "- jotted [[TARGET]]");
    const sources = idx.backlinks("target").map((b) => b.pageName).sort();
    expect(sources).toEqual(["2026-06-17", "Source"]);
    idx.close();
  });

  it("backlink refs carry the block text for preview", () => {
    const idx = new VaultIndex(":memory:");
    idx.upsertEntry("pages", "Source", "- here is a mention of [[Target]] inline");
    const refs = idx.backlinks("Target");
    expect(refs).toHaveLength(1);
    expect(refs[0].text).toContain("mention of");
    expect(refs[0].blockId).toBeTruthy();
    idx.close();
  });

  it("backlinkCounts groups by lowercased target", () => {
    const idx = new VaultIndex(":memory:");
    idx.upsertEntry("pages", "A", "- [[Topic]]");
    idx.upsertEntry("pages", "B", "- [[topic]]");
    expect(idx.backlinkCounts()["topic"]).toBe(2);
    idx.close();
  });

  it("re-upsert refreshes a source's outgoing links", () => {
    const idx = new VaultIndex(":memory:");
    idx.upsertEntry("pages", "S", "- [[Old]]");
    expect(idx.backlinks("old")).toHaveLength(1);
    idx.upsertEntry("pages", "S", "- [[New]] only");
    expect(idx.backlinks("old")).toHaveLength(0);
    expect(idx.backlinks("new")).toHaveLength(1);
    idx.close();
  });

  it("removeEntry drops its outgoing links", () => {
    const idx = new VaultIndex(":memory:");
    idx.upsertEntry("pages", "S", "- [[Target]]");
    expect(idx.backlinks("target")).toHaveLength(1);
    idx.removeEntry("pages", "S");
    expect(idx.backlinks("target")).toHaveLength(0);
    idx.close();
  });

  it("query is resilient to FTS special characters in user input", () => {
    const idx = new VaultIndex(":memory:");
    idx.upsertEntry("pages", "Quote", "- a line about parsers and tokens");
    // Inputs that would break a raw FTS MATCH if not sanitized.
    expect(() => idx.query('parsers "AND (tokens')).not.toThrow();
    expect(idx.query("parsers").map((h) => h.name)).toEqual(["Quote"]);
    idx.close();
  });

  it("rebuilds the index from a vault snapshot", async () => {
    const vault = fakeVault({
      pages: { Design: "- [[Target]] content", Target: "- hi" },
      journal: { "2026-06-17": "- a day in the life" },
      pagemeta: {
        Design: JSON.stringify({ created: "2026-06-01T00:00:00Z", updated: "2026-06-10T00:00:00Z" }),
      },
    });
    const idx = new VaultIndex(":memory:");
    await idx.rebuildFrom(vault);
    expect(idx.query("content").map((h) => h.name)).toEqual(["Design"]);
    expect(idx.query("life", { kinds: ["journal"] }).map((h) => h.name)).toEqual(["2026-06-17"]);
    expect(idx.backlinks("target").map((b) => b.pageName)).toEqual(["Design"]);
    idx.close();
  });

  it("rebuild clears any prior contents", async () => {
    const idx = new VaultIndex(":memory:");
    idx.upsertEntry("pages", "Stale", "- old data");
    await idx.rebuildFrom(fakeVault({ pages: { Fresh: "- new data" } }));
    expect(idx.query("old")).toEqual([]);
    expect(idx.query("new").map((h) => h.name)).toEqual(["Fresh"]);
    idx.close();
  });

  it("a newly opened index reports it needs a rebuild", () => {
    const idx = new VaultIndex(":memory:");
    expect(idx.needsRebuild()).toBe(true);
    idx.close();
  });
});
