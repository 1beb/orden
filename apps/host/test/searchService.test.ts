import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeHost } from "../src/nodeHost";

// The live indexer runs asynchronously off the change feed (it reads the entry
// back from the vault), so give those microtasks a tick before querying.
const settle = () => new Promise((r) => setTimeout(r, 20));

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "orden-search-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("NodeHost search", () => {
  it("advertises the search capability", () => {
    const host = new NodeHost({ vaultRoot: root });
    expect(host.capabilities().search).toBe(true);
    expect(host.search).toBeDefined();
    host.stop();
  });

  it("live-indexes page writes and finds them by content", async () => {
    const host = new NodeHost({ vaultRoot: root });
    await host.vault.set("pages", "Design Notes", "- the quick brown fox");
    await settle();
    const hits = await host.search.query("brown");
    expect(hits.map((h) => h.name)).toEqual(["Design Notes"]);
    expect(hits[0].snippet).toContain("brown");
    host.stop();
  });

  it("indexes backlinks across pages and journal, case-insensitively", async () => {
    const host = new NodeHost({ vaultRoot: root });
    await host.vault.set("pages", "Source", "- see [[Target]]");
    await host.vault.set("journal", "2026-06-17", "- [[target]] noted");
    await settle();
    const refs = await host.search.backlinks("Target");
    expect(refs.map((r) => r.pageName).sort()).toEqual(["2026-06-17", "Source"]);
    host.stop();
  });

  it("drops an entry from the index when its page is deleted", async () => {
    const host = new NodeHost({ vaultRoot: root });
    await host.vault.set("pages", "Temp", "- ephemeral content");
    await settle();
    expect((await host.search.query("ephemeral")).length).toBe(1);
    await host.vault.delete("pages", "Temp");
    await settle();
    expect(await host.search.query("ephemeral")).toEqual([]);
    host.stop();
  });

  it("initSearchIndex makes prior vault content searchable on a fresh host", async () => {
    const h1 = new NodeHost({ vaultRoot: root });
    await h1.vault.set("pages", "Prior", "- preexisting writing");
    await settle();
    h1.stop();

    const h2 = new NodeHost({ vaultRoot: root });
    await h2.initSearchIndex();
    expect((await h2.search.query("preexisting")).map((x) => x.name)).toEqual(["Prior"]);
    h2.stop();
  });
});
