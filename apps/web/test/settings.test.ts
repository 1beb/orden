import { beforeEach, describe, expect, it } from "vitest";
import { BrowserHost } from "../src/host/browserHost";
import { hydrateSettings, loadSettings, saveSettings } from "../src/settings";

const DEFAULTS = {
  startup: "last",
  fontFamily: "system",
  fontSize: 16,
  accent: "#6d28d9",
  showArchived: false,
  sessionAutoLaunch: true,
  sessionPanelWidth: 480,
};

describe("settings store (host-backed)", () => {
  beforeEach(async () => {
    localStorage.clear();
    await hydrateSettings(new BrowserHost());
  });

  it("returns full defaults before anything is saved", () => {
    expect(loadSettings()).toEqual(DEFAULTS);
  });

  it("round-trips startup synchronously via the cache", async () => {
    await saveSettings({ startup: "kanban" });
    expect(loadSettings().startup).toBe("kanban");
  });

  it("round-trips font family and size", async () => {
    await saveSettings({ fontFamily: "atkinson", fontSize: 18 });
    expect(loadSettings().fontFamily).toBe("atkinson");
    expect(loadSettings().fontSize).toBe(18);
  });

  it("a partial save merges, leaving other fields intact", async () => {
    await saveSettings({ startup: "journal" });
    await saveSettings({ fontFamily: "inter" });
    const s = loadSettings();
    expect(s.startup).toBe("journal");
    expect(s.fontFamily).toBe("inter");
  });

  it("round-trips the accent color", async () => {
    await saveSettings({ accent: "#ff8800" });
    expect(loadSettings().accent).toBe("#ff8800");
  });

  it("persists across a re-hydrate (fresh host over the same vault)", async () => {
    await saveSettings({ fontFamily: "lora", fontSize: 20, startup: "kanban", accent: "#0099ff" });
    await hydrateSettings(new BrowserHost());
    expect(loadSettings()).toEqual({
      startup: "kanban",
      fontFamily: "lora",
      fontSize: 20,
      accent: "#0099ff",
      showArchived: false,
      sessionAutoLaunch: true,
      sessionPanelWidth: 480,
    });
  });

  it("round-trips the session panel width", async () => {
    await saveSettings({ sessionPanelWidth: 560 });
    expect(loadSettings().sessionPanelWidth).toBe(560);
  });

  it("rejects an out-of-range panel width, falling back to the default", async () => {
    const h = new BrowserHost();
    await h.vault.set("settings", "app", { sessionPanelWidth: 9000 });
    await hydrateSettings(h);
    expect(loadSettings().sessionPanelWidth).toBe(480);
  });

  it("falls back to defaults for invalid stored values", async () => {
    const h = new BrowserHost();
    await h.vault.set("settings", "app", {
      startup: "bogus",
      fontFamily: "no-such-font",
      fontSize: "huge",
      accent: "not-a-color",
    });
    await hydrateSettings(h);
    expect(loadSettings()).toEqual(DEFAULTS);
  });

  it("rejects out-of-range font sizes", async () => {
    const h = new BrowserHost();
    await h.vault.set("settings", "app", { fontSize: 999 });
    await hydrateSettings(h);
    expect(loadSettings().fontSize).toBe(16);
  });
});
