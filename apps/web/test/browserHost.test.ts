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

  describe("locks", () => {
    it("acquire resolves ok for the single user", async () => {
      expect(await browserHost.locks.acquire("res")).toEqual({ ok: true });
    });
  });
});
