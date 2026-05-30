import { beforeEach, describe, expect, it } from "vitest";
import { BrowserHost } from "../src/host/browserHost";
import {
  backlinksTo,
  deletePage,
  getPageMarkdown,
  hydratePages,
  pageNames,
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
