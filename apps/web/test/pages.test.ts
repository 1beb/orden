import { beforeEach, describe, expect, it } from "vitest";
import { BrowserHost } from "../src/host/browserHost";
import {
  backlinksTo,
  deletePage,
  getPageMarkdown,
  hydratePages,
  journalDates,
  journalIndex,
  pageNames,
  pagesIndex,
  renamePage,
  setPageMarkdown,
} from "../src/pages";

const settle = () => new Promise((r) => setTimeout(r, 10));

describe("pages store (host-backed)", () => {
  beforeEach(async () => {
    localStorage.clear();
    await hydratePages(new BrowserHost());
  });

  it("returns empty markdown for an unknown page", () => {
    expect(getPageMarkdown("nope")).toBe("");
  });

  it("set -> get round-trips synchronously via the cache", () => {
    setPageMarkdown("home", "- hello");
    expect(getPageMarkdown("home")).toBe("- hello");
  });

  it("pageNames lists set pages, sorted", () => {
    setPageMarkdown("beta", "- b");
    setPageMarkdown("alpha", "- a");
    expect(pageNames()).toEqual(["alpha", "beta"]);
  });

  it("backlinksTo finds pages whose blocks reference the name", () => {
    setPageMarkdown("a", "- see [[b]]");
    setPageMarkdown("b", "- hi");
    expect(backlinksTo("b").length).toBeGreaterThanOrEqual(1);
  });

  it("persists across a re-hydrate (fresh host over the same vault)", async () => {
    setPageMarkdown("home", "- kept");
    await settle();
    await hydratePages(new BrowserHost());
    expect(getPageMarkdown("home")).toBe("- kept");
  });

  it("getPageMarkdown resolves case-insensitively to the canonical page", () => {
    setPageMarkdown("AgentNote", "- canonical");
    expect(getPageMarkdown("agentnote")).toBe("- canonical");
    expect(getPageMarkdown("AGENTNOTE")).toBe("- canonical");
  });

  it("setPageMarkdown via differing case updates the same page (no duplicate)", () => {
    setPageMarkdown("AgentNote", "- v1");
    setPageMarkdown("agentnote", "- v2");
    expect(getPageMarkdown("AgentNote")).toBe("- v2");
    expect(pageNames()).toEqual(["AgentNote"]);
  });

  it("deletePage removes the page from cache and listings", () => {
    setPageMarkdown("doomed", "- bye");
    expect(pageNames()).toContain("doomed");
    deletePage("doomed");
    expect(getPageMarkdown("doomed")).toBe("");
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

  it("journal day-pages route to the journal store, not pages", () => {
    setPageMarkdown("DesignNotes", "- a wiki page");
    setPageMarkdown("2026-05-24", "- a journal page");

    expect(pageNames()).toEqual(["DesignNotes"]);
    expect(journalDates()).toEqual(["2026-05-24"]);
    expect(journalIndex().map((p) => p.name)).toEqual(["2026-05-24"]);
    // Content still round-trips by name through the shared accessor.
    expect(getPageMarkdown("2026-05-24")).toBe("- a journal page");
  });

  it("a journal entry persists to the journal ns and survives re-hydrate", async () => {
    setPageMarkdown("2026-05-24", "- kept journal");
    await settle();
    await hydratePages(new BrowserHost());
    expect(getPageMarkdown("2026-05-24")).toBe("- kept journal");
    expect(journalDates()).toContain("2026-05-24");
    expect(pageNames()).not.toContain("2026-05-24");
  });

  it("backlinks still cross from a journal entry to a knowledge page", () => {
    setPageMarkdown("AI Suspects", "- a curated page");
    setPageMarkdown("2026-05-24", "- looked at [[AI Suspects]]");
    expect(backlinksTo("AI Suspects").length).toBeGreaterThanOrEqual(1);
  });

  it("migrates legacy journal day-pages out of the pages ns on hydrate", async () => {
    const host = new BrowserHost();
    // Simulate pre-split data: a date key sitting in the "pages" ns.
    await host.vault.set("pages", "2026-05-24", "- legacy journal");
    await host.vault.set("pages", "KnowledgePage", "- stays put");
    await hydratePages(host);

    expect(journalDates()).toContain("2026-05-24");
    expect(pageNames()).toEqual(["KnowledgePage"]);
    expect(getPageMarkdown("2026-05-24")).toBe("- legacy journal");
    // The legacy key is gone from the pages ns.
    expect(await host.vault.get<string>("pages", "2026-05-24")).toBeNull();
    expect(await host.vault.get<string>("journal", "2026-05-24")).toBe("- legacy journal");
  });

  it("internal card:/notes: pages stay readable and backlinkable though hidden from the index", () => {
    setPageMarkdown("card:item_abc_1", "- see [[Topic]]");
    expect(getPageMarkdown("card:item_abc_1")).toBe("- see [[Topic]]");
    expect(backlinksTo("Topic").length).toBeGreaterThanOrEqual(1);
  });

  it("deletePage resolves case-insensitively and persists across re-hydrate", async () => {
    setPageMarkdown("KeepMe", "- x");
    await settle();
    deletePage("keepme");
    await settle();
    await hydratePages(new BrowserHost());
    expect(getPageMarkdown("KeepMe")).toBe("");
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

  it("re-keys the body under the new name and drops the old key", () => {
    setPageMarkdown("Old Page", "- body content");
    expect(renamePage("Old Page", "New Page")).toEqual({ ok: true });
    expect(getPageMarkdown("New Page")).toBe("- body content");
    expect(getPageMarkdown("Old Page")).toBe("");
    expect(pageNames()).toContain("New Page");
    expect(pageNames()).not.toContain("Old Page");
  });

  it("persists the rename to the vault (survives re-hydrate)", async () => {
    setPageMarkdown("Old Page", "- body");
    await settle();
    renamePage("Old Page", "New Page");
    await settle();
    await hydratePages(host);
    expect(getPageMarkdown("New Page")).toBe("- body");
    expect(getPageMarkdown("Old Page")).toBe("");
    expect(await host.vault.get("pages", "Old Page")).toBeNull();
    expect(await host.vault.get("pages", "New Page")).toBe("- body");
  });

  it("carries page metadata across the rename", async () => {
    setPageMarkdown("Old Page", "- body");
    await settle();
    const before = await host.vault.get("pagemeta", "Old Page");
    expect(before).not.toBeNull();
    renamePage("Old Page", "New Page");
    await settle();
    expect(await host.vault.get("pagemeta", "Old Page")).toBeNull();
    expect(await host.vault.get("pagemeta", "New Page")).toEqual(before);
  });

  it("rewrites [[OldName]] references in other pages", () => {
    setPageMarkdown("Target", "- i am the target");
    setPageMarkdown("Referrer", "- see [[Target]] here");
    renamePage("Target", "Renamed");
    expect(getPageMarkdown("Referrer")).toBe("- see [[Renamed]] here");
    expect(backlinksTo("Renamed").length).toBeGreaterThanOrEqual(1);
    expect(backlinksTo("Target")).toHaveLength(0);
  });

  it("rewrites references in journal entries, case-insensitively and whitespace-tolerant", () => {
    setPageMarkdown("Target", "- target");
    setPageMarkdown("2026-06-17", "- jotted [[ target ]] today");
    renamePage("Target", "Renamed");
    expect(getPageMarkdown("2026-06-17")).toBe("- jotted [[Renamed]] today");
  });

  it("rewrites a self-reference in the renamed page's own body", () => {
    setPageMarkdown("Target", "- i link to [[Target]] myself");
    renamePage("Target", "Renamed");
    expect(getPageMarkdown("Renamed")).toBe("- i link to [[Renamed]] myself");
  });

  it("leaves unrelated entries untouched", () => {
    setPageMarkdown("Target", "- target");
    setPageMarkdown("Unrelated", "- nothing to see");
    renamePage("Target", "Renamed");
    expect(getPageMarkdown("Unrelated")).toBe("- nothing to see");
  });

  it("blocks a rename onto an existing page name (case-insensitive)", () => {
    setPageMarkdown("Alpha", "- a");
    setPageMarkdown("Beta", "- b");
    expect(renamePage("Alpha", "beta")).toEqual({
      ok: false,
      reason: 'A page named "Beta" already exists.',
    });
    expect(getPageMarkdown("Alpha")).toBe("- a");
    expect(getPageMarkdown("Beta")).toBe("- b");
  });

  it("allows re-casing a page's own name and rewrites its references", () => {
    setPageMarkdown("notes", "- jot");
    setPageMarkdown("Referrer", "- see [[notes]]");
    expect(renamePage("notes", "Notes")).toEqual({ ok: true });
    expect(pageNames()).toContain("Notes");
    expect(pageNames()).not.toContain("notes");
    expect(getPageMarkdown("Referrer")).toBe("- see [[Notes]]");
  });

  it("treats an unchanged name (modulo whitespace) as a no-op success", () => {
    setPageMarkdown("Same", "- x");
    expect(renamePage("Same", "  Same  ")).toEqual({ ok: true });
    expect(getPageMarkdown("Same")).toBe("- x");
  });

  it("rejects an empty name", () => {
    setPageMarkdown("Page", "- x");
    expect(renamePage("Page", "   ")).toEqual({ ok: false, reason: "Name can't be empty." });
  });

  it("rejects a date name (would collide with the journal store)", () => {
    setPageMarkdown("Page", "- x");
    expect(renamePage("Page", "2026-01-01")).toEqual({
      ok: false,
      reason: "A page name can't be a date.",
    });
  });

  it("rejects a reserved card:/notes: prefix", () => {
    setPageMarkdown("Page", "- x");
    expect(renamePage("Page", "card:123")).toEqual({ ok: false, reason: "That name is reserved." });
  });

  it("refuses to rename a journal day-page", () => {
    setPageMarkdown("2026-06-17", "- diary");
    expect(renamePage("2026-06-17", "My Day")).toEqual({
      ok: false,
      reason: "This page can't be renamed.",
    });
  });

  it("refuses to rename an internal derived page", () => {
    setPageMarkdown("card:abc", "- narrative");
    expect(renamePage("card:abc", "Story")).toEqual({
      ok: false,
      reason: "This page can't be renamed.",
    });
  });
});
