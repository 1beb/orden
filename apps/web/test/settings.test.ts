import { beforeEach, describe, expect, it } from "vitest";
import { BrowserHost } from "../src/host/browserHost";
import { coerce, hydrateSettings, loadSettings, saveSettings } from "../src/settings";

const DEFAULTS = {
  startup: "last",
  kanbanView: "board",
  fontFamily: "system",
  fontSize: 16,
  accent: "#6d28d9",
  showArchived: false,
  sessionAutoLaunch: true,
  sessionPanelPct: 33,
  completeFadeHours: 1,
  htmlRender: true,
  timeZone: "",
  defaultMode: { claude: "tui", opencode: "tui" },
  showScratchTerminal: true,
  worktreeIsolation: true,
  worktreeBaseRef: "",
  prForge: "auto",
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
      kanbanView: "board",
      fontFamily: "lora",
      fontSize: 20,
      accent: "#0099ff",
      showArchived: false,
      sessionAutoLaunch: true,
      sessionPanelPct: 33,
      completeFadeHours: 1,
      htmlRender: true,
      timeZone: "",
      defaultMode: { claude: "tui", opencode: "tui" },
      showScratchTerminal: true,
      worktreeIsolation: true,
      worktreeBaseRef: "",
      prForge: "auto",
    });
  });

  it("round-trips the html-render preference", async () => {
    await saveSettings({ htmlRender: false });
    expect(loadSettings().htmlRender).toBe(false);
  });

  it("rejects a non-boolean stored html-render value, falling back to the default", async () => {
    const h = new BrowserHost();
    await h.vault.set("settings", "app", { htmlRender: "yes" });
    await hydrateSettings(h);
    expect(loadSettings().htmlRender).toBe(true);
  });

  it("round-trips a valid IANA time zone", async () => {
    await saveSettings({ timeZone: "America/Vancouver" });
    expect(loadSettings().timeZone).toBe("America/Vancouver");
  });

  it("rejects an unrecognized time zone, falling back to inherit (\"\")", async () => {
    const h = new BrowserHost();
    await h.vault.set("settings", "app", { timeZone: "Mars/Olympus_Mons" });
    await hydrateSettings(h);
    expect(loadSettings().timeZone).toBe("");
  });

  it("round-trips the completed-card fade hours", async () => {
    await saveSettings({ completeFadeHours: 8 });
    expect(loadSettings().completeFadeHours).toBe(8);
  });

  it("rejects a fade-hours value outside the allowed set, falling back to default", async () => {
    const h = new BrowserHost();
    await h.vault.set("settings", "app", { completeFadeHours: 3 });
    await hydrateSettings(h);
    expect(loadSettings().completeFadeHours).toBe(1);
  });

  it("round-trips the session panel width percent", async () => {
    await saveSettings({ sessionPanelPct: 45 });
    expect(loadSettings().sessionPanelPct).toBe(45);
  });

  it("rejects an out-of-range panel width percent, falling back to the default", async () => {
    const h = new BrowserHost();
    await h.vault.set("settings", "app", { sessionPanelPct: 90 });
    await hydrateSettings(h);
    expect(loadSettings().sessionPanelPct).toBe(33);
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

  it("defaults defaultMode to tui for both tools and showScratchTerminal to true", () => {
    const s = coerce({});
    expect(s.defaultMode).toEqual({ claude: "tui", opencode: "tui" });
    expect(s.showScratchTerminal).toBe(true);
  });

  it("accepts a valid defaultMode and rejects garbage per-tool", () => {
    expect(coerce({ defaultMode: { claude: "gui", opencode: "tui" } }).defaultMode)
      .toEqual({ claude: "gui", opencode: "tui" });
    expect(coerce({ defaultMode: { claude: "nonsense" } }).defaultMode)
      .toEqual({ claude: "tui", opencode: "tui" });
    expect(coerce({ defaultMode: "not-an-object" }).defaultMode)
      .toEqual({ claude: "tui", opencode: "tui" });
  });

  it("coerces a non-boolean showScratchTerminal to the default", () => {
    expect(coerce({ showScratchTerminal: "yes" }).showScratchTerminal).toBe(true);
    expect(coerce({ showScratchTerminal: false }).showScratchTerminal).toBe(false);
  });
  it("defaults the worktree isolation fields", () => {
    const s = coerce({});
    expect(s.worktreeIsolation).toBe(true);
    expect(s.worktreeBaseRef).toBe("");
    expect(s.prForge).toBe("auto");
  });

  it("keeps valid worktree fields and rejects junk", () => {
    expect(coerce({ worktreeIsolation: false }).worktreeIsolation).toBe(false);
    expect(coerce({ worktreeBaseRef: "origin/develop" }).worktreeBaseRef).toBe("origin/develop");
    expect(coerce({ prForge: "glab" }).prForge).toBe("glab");
    expect(coerce({ prForge: "hg" }).prForge).toBe("auto");
    expect(coerce({ worktreeBaseRef: 42 }).worktreeBaseRef).toBe("");
  });

});
