import { beforeEach, describe, expect, it } from "vitest";
import { BrowserHost } from "../src/host/browserHost";
import { hydrateSettings, loadSettings, saveSettings } from "../src/settings";

// Settings now live in the host vault. The accessors stay synchronous (backed
// by a cache hydrated at boot); writes write through to the vault. Verified
// against a real BrowserHost vault, not a mock.

describe("settings store (host-backed)", () => {
  beforeEach(async () => {
    localStorage.clear();
    await hydrateSettings(new BrowserHost());
  });

  it("returns default before anything is saved", () => {
    expect(loadSettings()).toEqual({ startup: "last" });
  });

  it("round-trips save -> load synchronously via the cache", async () => {
    await saveSettings({ startup: "kanban" });
    expect(loadSettings()).toEqual({ startup: "kanban" });
  });

  it("persists across a re-hydrate (fresh host over the same vault)", async () => {
    await saveSettings({ startup: "journal" });
    await hydrateSettings(new BrowserHost());
    expect(loadSettings()).toEqual({ startup: "journal" });
  });

  it("falls back to default when the stored startup value is invalid", async () => {
    const h = new BrowserHost();
    await h.vault.set("settings", "app", { startup: "bogus" });
    await hydrateSettings(h);
    expect(loadSettings()).toEqual({ startup: "last" });
  });

  it("falls back to default when the stored value is not an object", async () => {
    const h = new BrowserHost();
    await h.vault.set("settings", "app", "kanban");
    await hydrateSettings(h);
    expect(loadSettings()).toEqual({ startup: "last" });
  });
});
