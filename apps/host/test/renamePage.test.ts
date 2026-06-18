import { describe, it, expect, beforeEach } from "vitest";
import { renamePageInVault, type VaultStore } from "@orden/host-api";

// A trivial in-memory VaultStore — the rename logic only needs get/set/list/delete.
function fakeVault(seed: Record<string, Record<string, string>> = {}): VaultStore {
  const data: Record<string, Record<string, unknown>> = {};
  for (const [ns, kv] of Object.entries(seed)) data[ns] = { ...kv };
  return {
    async get<T>(ns: string, key: string) {
      return ((data[ns]?.[key] as T) ?? null) as T | null;
    },
    async set<T>(ns: string, key: string, value: T) {
      (data[ns] ??= {})[key] = value;
    },
    async list(ns: string) {
      return Object.keys(data[ns] ?? {});
    },
    async delete(ns: string, key: string) {
      delete data[ns]?.[key];
    },
  };
}

let vault: VaultStore;
beforeEach(() => {
  vault = fakeVault();
});

describe("renamePageInVault", () => {
  it("re-keys the body under the new name and drops the old key", async () => {
    await vault.set("pages", "Old", "- body");
    const r = await renamePageInVault(vault, "Old", "New");
    expect(r).toEqual({ ok: true });
    expect(await vault.get<string>("pages", "New")).toBe("- body");
    expect(await vault.get<string>("pages", "Old")).toBeNull();
  });

  it("carries page metadata across the rename", async () => {
    await vault.set("pages", "Old", "- body");
    await vault.set("pagemeta", "Old", { created: "2026-06-01T00:00:00Z", updated: "2026-06-02T00:00:00Z" });
    await renamePageInVault(vault, "Old", "New");
    expect(await vault.get("pagemeta", "New")).toEqual({
      created: "2026-06-01T00:00:00Z",
      updated: "2026-06-02T00:00:00Z",
    });
    expect(await vault.get("pagemeta", "Old")).toBeNull();
  });

  it("rewrites [[OldName]] references in other pages", async () => {
    await vault.set("pages", "Target", "- i am the target");
    await vault.set("pages", "Referrer", "- see [[Target]] here");
    await renamePageInVault(vault, "Target", "Renamed");
    expect(await vault.get<string>("pages", "Referrer")).toBe("- see [[Renamed]] here");
  });

  it("rewrites references in journal entries, case-insensitively and whitespace-tolerant", async () => {
    await vault.set("pages", "Target", "- target");
    await vault.set("journal", "2026-06-17", "- jotted [[ target ]] today");
    await renamePageInVault(vault, "Target", "Renamed");
    expect(await vault.get<string>("journal", "2026-06-17")).toBe("- jotted [[Renamed]] today");
  });

  it("rewrites a self-reference in the renamed page's own body", async () => {
    await vault.set("pages", "Self", "- I link [[Self]]");
    await renamePageInVault(vault, "Self", "Renamed");
    expect(await vault.get<string>("pages", "Renamed")).toBe("- I link [[Renamed]]");
  });

  it("leaves unrelated entries untouched", async () => {
    await vault.set("pages", "Target", "- t");
    await vault.set("pages", "Unrelated", "- nothing here");
    await renamePageInVault(vault, "Target", "Renamed");
    expect(await vault.get<string>("pages", "Unrelated")).toBe("- nothing here");
  });

  it("blocks a rename onto an existing page name (case-insensitive)", async () => {
    await vault.set("pages", "Target", "- t");
    await vault.set("pages", "Taken", "- u");
    const r = await renamePageInVault(vault, "Target", "taken");
    expect(r).toEqual({ ok: false, reason: 'A page named "Taken" already exists.' });
    expect(await vault.get<string>("pages", "Target")).toBe("- t"); // unchanged
  });

  it("allows re-casing a page's own name and rewrites its references", async () => {
    await vault.set("pages", "notes", "- self [[notes]]");
    const r = await renamePageInVault(vault, "notes", "Notes");
    expect(r).toEqual({ ok: true });
    expect(await vault.get<string>("pages", "Notes")).toBe("- self [[Notes]]");
    expect(await vault.get<string>("pages", "notes")).toBeNull();
  });

  it("treats an unchanged name (modulo whitespace) as a no-op success", async () => {
    await vault.set("pages", "Same", "- body");
    const r = await renamePageInVault(vault, "Same", "  Same  ");
    expect(r).toEqual({ ok: true });
    expect(await vault.get<string>("pages", "Same")).toBe("- body");
  });

  it("rejects an empty name", async () => {
    await vault.set("pages", "Old", "- b");
    expect(await renamePageInVault(vault, "Old", "  ")).toEqual({ ok: false, reason: "Name can't be empty." });
  });

  it("rejects a date name (would collide with the journal store)", async () => {
    await vault.set("pages", "Old", "- b");
    expect(await renamePageInVault(vault, "Old", "2026-06-17")).toEqual({
      ok: false,
      reason: "A page name can't be a date.",
    });
  });

  it("rejects a reserved card:/notes: prefix", async () => {
    await vault.set("pages", "Old", "- b");
    expect(await renamePageInVault(vault, "Old", "card:abc")).toEqual({
      ok: false,
      reason: "That name is reserved.",
    });
  });

  it("refuses to rename a journal day-page", async () => {
    await vault.set("journal", "2026-06-17", "- a day");
    expect(await renamePageInVault(vault, "2026-06-17", "Something")).toEqual({
      ok: false,
      reason: "This page can't be renamed.",
    });
  });

  it("refuses to rename an internal derived page", async () => {
    await vault.set("pages", "card:item_1", "- narrative");
    expect(await renamePageInVault(vault, "card:item_1", "Something")).toEqual({
      ok: false,
      reason: "This page can't be renamed.",
    });
  });

  it("resolves the old name case-insensitively to its stored casing", async () => {
    await vault.set("pages", "AgentNote", "- canonical");
    await vault.set("pages", "Ref", "- see [[AgentNote]]");
    const r = await renamePageInVault(vault, "agentnote", "Renamed");
    expect(r).toEqual({ ok: true });
    expect(await vault.get<string>("pages", "Renamed")).toBe("- canonical");
    expect(await vault.get<string>("pages", "Ref")).toBe("- see [[Renamed]]");
  });
});
