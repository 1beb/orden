import { beforeEach, describe, expect, it } from "vitest";
import { BrowserHost } from "../src/host/browserHost";
import {
  hydrateRecentFiles,
  listRecentFiles,
  recordRecentFile,
  STORE_CAP,
  type RecentFile,
} from "../src/recentFiles";

const settle = () => new Promise((r) => setTimeout(r, 10));

// The vault key the store writes to (ns "ui", key "recent-files").
async function stored(h: BrowserHost): Promise<unknown> {
  return h.vault.get("ui", "recent-files");
}

describe("recentFiles store (host-backed)", () => {
  beforeEach(async () => {
    localStorage.clear();
    await hydrateRecentFiles(new BrowserHost());
  });

  it("record + list returns {projectId, path} newest-first", () => {
    recordRecentFile("repo", "a.md");
    recordRecentFile("repo", "b.md");
    expect(listRecentFiles()).toEqual<RecentFile[]>([
      { projectId: "repo", path: "b.md" },
      { projectId: "repo", path: "a.md" },
    ]);
  });

  it("dedups by (projectId, path) and moves the re-recorded entry to the front", () => {
    recordRecentFile("repo", "a.md");
    recordRecentFile("repo", "b.md");
    recordRecentFile("repo", "a.md");
    expect(listRecentFiles()).toEqual<RecentFile[]>([
      { projectId: "repo", path: "a.md" },
      { projectId: "repo", path: "b.md" },
    ]);
  });

  it("treats the same path under a different projectId as a separate entry", () => {
    recordRecentFile("repo", "a.md");
    recordRecentFile("other", "a.md");
    expect(listRecentFiles()).toEqual<RecentFile[]>([
      { projectId: "other", path: "a.md" },
      { projectId: "repo", path: "a.md" },
    ]);
  });

  it("caps at STORE_CAP", () => {
    for (let i = 0; i < STORE_CAP + 5; i++) recordRecentFile("repo", `f${i}.md`);
    const list = listRecentFiles();
    expect(list).toHaveLength(STORE_CAP);
    // Newest first: the last recorded is at the front.
    expect(list[0]).toEqual({ projectId: "repo", path: `f${STORE_CAP + 4}.md` });
  });

  it("migrates a legacy string[] to {projectId:'repo', path}", async () => {
    const h = new BrowserHost();
    await h.vault.set("ui", "recent-files", ["a.md", "b.md"]);
    await hydrateRecentFiles(h);
    expect(listRecentFiles()).toEqual<RecentFile[]>([
      { projectId: "repo", path: "a.md" },
      { projectId: "repo", path: "b.md" },
    ]);
  });

  it("drops garbage/mixed entries on hydrate without crashing", async () => {
    const h = new BrowserHost();
    await h.vault.set("ui", "recent-files", [
      "a.md", // legacy string -> repo
      { projectId: "p1", path: "ok.md" }, // valid object
      { projectId: 5, path: "bad.md" }, // bad projectId type
      { path: "no-pid.md" }, // missing projectId
      null, // junk
      42, // junk
    ]);
    await hydrateRecentFiles(h);
    expect(listRecentFiles()).toEqual<RecentFile[]>([
      { projectId: "repo", path: "a.md" },
      { projectId: "p1", path: "ok.md" },
    ]);
  });

  it("persists the object array to the vault (assert via the stored value)", async () => {
    recordRecentFile("repo", "a.md");
    recordRecentFile("other", "b.md");
    await settle();
    expect(await stored(new BrowserHost())).toEqual([
      { projectId: "other", path: "b.md" },
      { projectId: "repo", path: "a.md" },
    ]);
  });

  it("persists across a re-hydrate", async () => {
    recordRecentFile("repo", "a.md");
    await settle();
    await hydrateRecentFiles(new BrowserHost());
    expect(listRecentFiles()).toEqual<RecentFile[]>([{ projectId: "repo", path: "a.md" }]);
  });
});
