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
