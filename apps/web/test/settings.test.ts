import { beforeEach, describe, expect, it } from "vitest";
import { loadSettings, saveSettings, type Settings } from "../src/settings";

const KEY = "orden:settings";

describe("settings store", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns default when storage is empty", () => {
    expect(loadSettings()).toEqual({ startup: "last" });
  });

  it("round-trips save -> load", () => {
    const s: Settings = { startup: "kanban" };
    saveSettings(s);
    expect(loadSettings()).toEqual({ startup: "kanban" });
  });

  it("persists the saved value as JSON under the orden:settings key", () => {
    saveSettings({ startup: "journal" });
    expect(JSON.parse(localStorage.getItem(KEY) as string)).toEqual({
      startup: "journal",
    });
  });

  it("returns default when stored JSON is malformed (no throw)", () => {
    localStorage.setItem(KEY, "{not valid json");
    expect(() => loadSettings()).not.toThrow();
    expect(loadSettings()).toEqual({ startup: "last" });
  });

  it("returns default when startup value is invalid", () => {
    localStorage.setItem(KEY, JSON.stringify({ startup: "bogus" }));
    expect(loadSettings()).toEqual({ startup: "last" });
  });

  it("returns default when stored JSON is not an object", () => {
    localStorage.setItem(KEY, JSON.stringify("kanban"));
    expect(loadSettings()).toEqual({ startup: "last" });
  });
});
