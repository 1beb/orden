import { beforeEach, describe, expect, it } from "vitest";
import type { Host } from "@orden/host-api";
import { BrowserHost } from "../src/host/browserHost";
import {
  backlinkCounts,
  backlinksTo,
  deletePage,
  getPageBody,
  hydratePages,
  journalDates,
  journalIndex,
  pageNames,
  pagesIndex,
  renamePage,
  setPageMarkdown,
} from "../src/pages";
import { renderPagesIndex } from "../src/pagesIndex";

const settle = () => new Promise((r) => setTimeout(r, 10));

describe("pages store (host-backed)", () => {
  beforeEach(async () => {
    localStorage.clear();
    await hydratePages(new BrowserHost());
  });

  it("returns empty body for an unknown page", async () => {
    expect(await getPageBody("nope")).toBe("");
  });

  it("set -> get round-trips through the body LRU", async () => {
    setPageMarkdown("home", "- hello");
    expect(await getPageBody("home")).toBe("- hello");
  });

  it("pageNames lists set pages, sorted", () => {
    setPageMarkdown("beta", "- b");
    setPageMarkdown("alpha", "- a");
    expect(pageNames()).toEqual(["alpha", "beta"]);
  });

  it("backlinksTo finds pages whose blocks reference the name", async () => {
    setPageMarkdown("a", "- see [[b]]");
    setPageMarkdown("b", "- hi");
    expect((await backlinksTo("b")).length).toBeGreaterThanOrEqual(1);
  });

  it("backlinkCounts groups by lowercased target across pages and journal", async () => {
    setPageMarkdown("Source", "- see [[Topic]]");
    setPageMarkdown("2026-05-24", "- also [[topic]]");
    const counts = await backlinkCounts();
    expect(counts["topic"]).toBeGreaterThanOrEqual(2);
  });

  it("persists across a re-hydrate (fresh host over the same vault)", async () => {
    setPageMarkdown("home", "- kept");
    await settle();
    await hydratePages(new BrowserHost());
    expect(await getPageBody("home")).toBe("- kept");
  });

  it("getPageBody resolves case-insensitively to the canonical page", async () => {
    setPageMarkdown("AgentNote", "- canonical");
    expect(await getPageBody("agentnote")).toBe("- canonical");
    expect(await getPageBody("AGENTNOTE")).toBe("- canonical");
  });

  it("setPageMarkdown via differing case updates the same page (no duplicate)", async () => {
    setPageMarkdown("AgentNote", "- v1");
    setPageMarkdown("agentnote", "- v2");
    expect(await getPageBody("AgentNote")).toBe("- v2");
    expect(pageNames()).toEqual(["AgentNote"]);
  });

  it("deletePage removes the page from listings and vault", async () => {
    setPageMarkdown("doomed", "- bye");
    expect(pageNames()).toContain("doomed");
    deletePage("doomed");
    expect(await getPageBody("doomed")).toBe("");
    expect(pageNames()).not.toContain("doomed");
  });

  it("pagesIndex omits internal card:/notes: pages AND journal day-pages", () => {
    setPageMarkdown("DesignNotes", "- a wiki page");
    setPageMarkdown("2026-05-24", "- a journal page");
    setPageMarkdown("card:item_abc_1", "- a card narrative");
    setPageMarkdown("notes:proj_x", "- project notes");

    const names = pagesIndex().map((p) => p.name);
    expect(names).toContain("DesignNotes");
    expect(names).not.toContain("2026-05-24"); // journal lives in its own store
    expect(names).not.toContain("card:item_abc_1");
    expect(names).not.toContain("notes:proj_x");
  });

  it("journal day-pages route to the journal store, not pages", async () => {
    setPageMarkdown("DesignNotes", "- a wiki page");
    setPageMarkdown("2026-05-24", "- a journal page");

    expect(pageNames()).toEqual(["DesignNotes"]);
    expect(journalDates()).toEqual(["2026-05-24"]);
    expect(journalIndex().map((p) => p.name)).toEqual(["2026-05-24"]);
    // Content still round-trips by name through the shared accessor.
    expect(await getPageBody("2026-05-24")).toBe("- a journal page");
  });

  it("a journal entry persists to the journal ns and survives re-hydrate", async () => {
    setPageMarkdown("2026-05-24", "- kept journal");
    await settle();
    await hydratePages(new BrowserHost());
    expect(await getPageBody("2026-05-24")).toBe("- kept journal");
    expect(journalDates()).toContain("2026-05-24");
    expect(pageNames()).not.toContain("2026-05-24");
  });

  it("backlinks still cross from a journal entry to a knowledge page", async () => {
    setPageMarkdown("AI Suspects", "- a curated page");
    setPageMarkdown("2026-05-24", "- looked at [[AI Suspects]]");
    expect((await backlinksTo("AI Suspects")).length).toBeGreaterThanOrEqual(1);
  });

  it("migrates legacy journal day-pages out of the pages ns on hydrate", async () => {
    const host = new BrowserHost();
    // Simulate pre-split data: a date key sitting in the "pages" ns.
    await host.vault.set("pages", "2026-05-24", "- legacy journal");
    await host.vault.set("pages", "KnowledgePage", "- stays put");
    await hydratePages(host);

    expect(journalDates()).toContain("2026-05-24");
    expect(pageNames()).toEqual(["KnowledgePage"]);
    expect(await getPageBody("2026-05-24")).toBe("- legacy journal");
    // The legacy key is gone from the pages ns.
    expect(await host.vault.get<string>("pages", "2026-05-24")).toBeNull();
    expect(await host.vault.get<string>("journal", "2026-05-24")).toBe("- legacy journal");
  });

  it("internal card:/notes: pages stay readable and backlinkable though hidden from the index", async () => {
    setPageMarkdown("card:item_abc_1", "- see [[Topic]]");
    expect(await getPageBody("card:item_abc_1")).toBe("- see [[Topic]]");
    expect((await backlinksTo("Topic")).length).toBeGreaterThanOrEqual(1);
  });

  it("deletePage resolves case-insensitively and persists across re-hydrate", async () => {
    setPageMarkdown("KeepMe", "- x");
    await settle();
    deletePage("keepme");
    await settle();
    await hydratePages(new BrowserHost());
    expect(await getPageBody("KeepMe")).toBe("");
    expect(pageNames()).not.toContain("KeepMe");
  });
});

describe("renamePage", () => {
  let host: BrowserHost;
  beforeEach(async () => {
    localStorage.clear();
    host = new BrowserHost();
    await hydratePages(host);
  });

  it("re-keys the body under the new name and drops the old key", async () => {
    setPageMarkdown("Old Page", "- body content");
    expect(await renamePage("Old Page", "New Page")).toEqual({ ok: true });
    expect(await getPageBody("New Page")).toBe("- body content");
    expect(await getPageBody("Old Page")).toBe("");
    expect(pageNames()).toContain("New Page");
    expect(pageNames()).not.toContain("Old Page");
  });

  it("persists the rename to the vault (survives re-hydrate)", async () => {
    setPageMarkdown("Old Page", "- body");
    await settle();
    await renamePage("Old Page", "New Page");
    await settle();
    await hydratePages(host);
    expect(await getPageBody("New Page")).toBe("- body");
    expect(await getPageBody("Old Page")).toBe("");
    expect(await host.vault.get("pages", "Old Page")).toBeNull();
    expect(await host.vault.get("pages", "New Page")).toBe("- body");
  });

  it("carries page metadata across the rename", async () => {
    setPageMarkdown("Old Page", "- body");
    await settle();
    const before = await host.vault.get("pagemeta", "Old Page");
    expect(before).not.toBeNull();
    await renamePage("Old Page", "New Page");
    await settle();
    expect(await host.vault.get("pagemeta", "Old Page")).toBeNull();
    expect(await host.vault.get("pagemeta", "New Page")).toEqual(before);
  });

  it("rewrites [[OldName]] references in other pages", async () => {
    setPageMarkdown("Target", "- i am the target");
    setPageMarkdown("Referrer", "- see [[Target]] here");
    await renamePage("Target", "Renamed");
    expect(await getPageBody("Referrer")).toBe("- see [[Renamed]] here");
    expect((await backlinksTo("Renamed")).length).toBeGreaterThanOrEqual(1);
    expect(await backlinksTo("Target")).toHaveLength(0);
  });

  it("rewrites references in journal entries, case-insensitively and whitespace-tolerant", async () => {
    setPageMarkdown("Target", "- target");
    setPageMarkdown("2026-06-17", "- jotted [[ target ]] today");
    await renamePage("Target", "Renamed");
    expect(await getPageBody("2026-06-17")).toBe("- jotted [[Renamed]] today");
  });

  it("rewrites a self-reference in the renamed page's own body", async () => {
    setPageMarkdown("Target", "- i link to [[Target]] myself");
    await renamePage("Target", "Renamed");
    expect(await getPageBody("Renamed")).toBe("- i link to [[Renamed]] myself");
  });

  it("leaves unrelated entries untouched", async () => {
    setPageMarkdown("Target", "- target");
    setPageMarkdown("Unrelated", "- nothing to see");
    await renamePage("Target", "Renamed");
    expect(await getPageBody("Unrelated")).toBe("- nothing to see");
  });

  it("blocks a rename onto an existing page name (case-insensitive)", async () => {
    setPageMarkdown("Alpha", "- a");
    setPageMarkdown("Beta", "- b");
    expect(await renamePage("Alpha", "beta")).toEqual({
      ok: false,
      reason: 'A page named "Beta" already exists.',
    });
    expect(await getPageBody("Alpha")).toBe("- a");
    expect(await getPageBody("Beta")).toBe("- b");
  });

  it("allows re-casing a page's own name and rewrites its references", async () => {
    setPageMarkdown("notes", "- jot");
    setPageMarkdown("Referrer", "- see [[notes]]");
    expect(await renamePage("notes", "Notes")).toEqual({ ok: true });
    expect(pageNames()).toContain("Notes");
    expect(pageNames()).not.toContain("notes");
    expect(await getPageBody("Referrer")).toBe("- see [[Notes]]");
  });

  it("treats an unchanged name (modulo whitespace) as a no-op success", async () => {
    setPageMarkdown("Same", "- x");
    expect(await renamePage("Same", "  Same  ")).toEqual({ ok: true });
    expect(await getPageBody("Same")).toBe("- x");
  });

  it("rejects an empty name", async () => {
    setPageMarkdown("Page", "- x");
    expect(await renamePage("Page", "   ")).toEqual({ ok: false, reason: "Name can't be empty." });
  });

  it("rejects a date name (would collide with the journal store)", async () => {
    setPageMarkdown("Page", "- x");
    expect(await renamePage("Page", "2026-01-01")).toEqual({
      ok: false,
      reason: "A page name can't be a date.",
    });
  });

  it("rejects a reserved card:/notes: prefix", async () => {
    setPageMarkdown("Page", "- x");
    expect(await renamePage("Page", "card:123")).toEqual({ ok: false, reason: "That name is reserved." });
  });

  it("refuses to rename a journal day-page", async () => {
    setPageMarkdown("2026-06-17", "- diary");
    expect(await renamePage("2026-06-17", "My Day")).toEqual({
      ok: false,
      reason: "This page can't be renamed.",
    });
  });

  it("refuses to rename an internal derived page", async () => {
    setPageMarkdown("card:abc", "- narrative");
    expect(await renamePage("card:abc", "Story")).toEqual({
      ok: false,
      reason: "This page can't be renamed.",
    });
  });
});

// Reproduces the live NodeHost-over-RPC condition behind "the Pages nav leads to
// an empty page": the RPC client attaches a `search` proxy for EVERY capability
// name (apps/host/src/rpc.ts), so `host.search` is always a truthy object even
// when the server lacks the capability — invoking a method then throws "unknown
// capability: search". `capabilities().search` is the real gate, and it is falsy
// here. Guarding on `host.search` truthiness lets that throw blank the whole
// Pages list; gating on the capability flag (and not letting an optional backlink
// badge abort the render) keeps the list visible.
function makeHostWithoutSearch(seed: Record<string, string>): Host {
  const store = new Map<string, Map<string, unknown>>();
  const nsMap = (ns: string): Map<string, unknown> => {
    let m = store.get(ns);
    if (!m) store.set(ns, (m = new Map()));
    return m;
  };
  for (const [name, body] of Object.entries(seed)) nsMap("pages").set(name, body);

  const throwingSearch = new Proxy(
    {},
    { get: () => async () => { throw new Error("unknown capability: search"); } },
  );

  return {
    capabilities: () => ({ search: false }),
    search: throwingSearch,
    vault: {
      async list(ns: string) {
        return [...nsMap(ns).keys()];
      },
      async get(ns: string, key: string) {
        return (nsMap(ns).get(key) as unknown) ?? null;
      },
      async set(ns: string, key: string, v: unknown) {
        nsMap(ns).set(key, v);
      },
      async delete(ns: string, key: string) {
        nsMap(ns).delete(key);
      },
    },
  } as unknown as Host;
}

describe("pages list resilience when host search is unavailable", () => {
  beforeEach(async () => {
    await hydratePages(makeHostWithoutSearch({ Alpha: "# Alpha [[Beta]]", Beta: "# Beta" }));
  });

  it("backlinkCounts degrades to empty instead of throwing", async () => {
    await expect(backlinkCounts()).resolves.toEqual({});
  });

  it("backlinksTo degrades to empty instead of throwing", async () => {
    await expect(backlinksTo("Beta")).resolves.toEqual([]);
  });

  it("renderPagesIndex still renders the page rows when search throws", async () => {
    const container = document.createElement("div");
    await renderPagesIndex(container, () => {});
    const rows = container.querySelectorAll("table.pages-table tbody tr");
    expect(rows.length).toBe(2);
  });
});
