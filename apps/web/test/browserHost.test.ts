import { beforeEach, describe, expect, it } from "vitest";
import { BrowserHost, browserHost } from "../src/host/browserHost";

describe("BrowserHost", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("reports the expected capabilities", () => {
    expect(browserHost.capabilities()).toEqual({
      remoteProjects: false,
      spawnSessions: false,
      persistentVault: true,
      search: true,
    });
  });

  describe("search (in-memory fallback)", () => {
    let host: BrowserHost;
    beforeEach(() => {
      host = new BrowserHost();
    });

    it("finds pages by body content with a bracketed snippet", async () => {
      await host.vault.set("pages", "Design", "- the quick brown fox");
      await host.vault.set("pages", "Other", "- nothing here");
      const hits = await host.search!.query("brown");
      expect(hits.map((h) => h.name)).toEqual(["Design"]);
      expect(hits[0].snippet).toContain("[brown]");
    });

    it("ranks name matches ahead of body-only matches", async () => {
      await host.vault.set("pages", "Roadmap", "- nothing relevant");
      await host.vault.set("pages", "Other", "- mentions roadmap in the body");
      const hits = await host.search!.query("roadmap");
      expect(hits.map((h) => h.name)).toEqual(["Roadmap", "Other"]);
    });

    it("filters by kind", async () => {
      await host.vault.set("pages", "P", "- shared term");
      await host.vault.set("journal", "2026-06-17", "- shared term");
      const hits = await host.search!.query("shared", { kinds: ["journal"] });
      expect(hits.map((h) => h.name)).toEqual(["2026-06-17"]);
    });

    it("resolves backlinks across pages and journal, case-insensitively", async () => {
      await host.vault.set("pages", "Source", "- see [[Target]] and [[ target ]]");
      await host.vault.set("journal", "2026-06-17", "- [[TARGET]] noted");
      const refs = await host.search!.backlinks("target");
      expect(refs.map((r) => r.pageName).sort()).toEqual(["2026-06-17", "Source"]);
    });

    it("counts backlinks grouped by lowercased target", async () => {
      await host.vault.set("pages", "A", "- [[Topic]]");
      await host.vault.set("pages", "B", "- [[topic]]");
      expect((await host.search!.backlinkCounts())["topic"]).toBe(2);
    });

    it("returns nothing for an empty query", async () => {
      await host.vault.set("pages", "A", "- content");
      expect(await host.search!.query("   ")).toEqual([]);
    });
  });

  describe("vault", () => {
    const host = new BrowserHost();

    it("round-trips a value", async () => {
      await host.vault.set("settings", "theme", { mode: "dark" });
      expect(await host.vault.get("settings", "theme")).toEqual({ mode: "dark" });
    });

    it("returns null for an absent key", async () => {
      expect(await host.vault.get("settings", "missing")).toBeNull();
    });

    it("lists keys present in a namespace", async () => {
      await host.vault.set("ns1", "a", 1);
      await host.vault.set("ns1", "b", 2);
      await host.vault.set("ns2", "c", 3);
      const keys = await host.vault.list("ns1");
      expect(keys.sort()).toEqual(["a", "b"]);
    });

    it("deletes a single key", async () => {
      await host.vault.set("ns", "k", "v");
      await host.vault.delete("ns", "k");
      expect(await host.vault.get("ns", "k")).toBeNull();
    });

    it("returns null (no throw) for malformed JSON", async () => {
      localStorage.setItem("orden:vault:ns:bad", "{not json");
      expect(await host.vault.get("ns", "bad")).toBeNull();
    });
  });

  describe("projects", () => {
    beforeEach(() => {
      localStorage.removeItem("orden:projects");
    });

    it("adds a project that then appears in the list", async () => {
      const host = new BrowserHost();
      const added = await host.projects.add({ kind: "local", path: "/home/me/work" }, "Work");
      const list = await host.projects.list();
      expect(list.map((p) => p.id)).toContain(added.id);
      expect(added.name).toBe("Work");
    });

    it("derives a name from a local path basename when none given", async () => {
      const host = new BrowserHost();
      const added = await host.projects.add({ kind: "local", path: "/home/me/work" });
      expect(added.name).toBe("work");
    });
  });

  describe("sessions", () => {
    it("cannot spawn (capability disabled)", async () => {
      expect(browserHost.capabilities().spawnSessions).toBe(false);
      await expect(
        browserHost.sessions.spawn("p", { title: "t", agent: "claude" }),
      ).rejects.toThrow();
    });
  });

  describe("chat", () => {
    it("lists no sessions (no host backend)", async () => {
      expect(await browserHost.chat.listSessions()).toEqual([]);
    });

    it("cannot create a session", async () => {
      await expect(
        browserHost.chat.createSession({ harness: "claude", cwd: "/tmp" }),
      ).rejects.toThrow(/no chat backend/);
    });
  });

  describe("locks", () => {
    it("acquire resolves ok for the single user", async () => {
      expect(await browserHost.locks.acquire("res")).toEqual({ ok: true });
    });
  });
});
