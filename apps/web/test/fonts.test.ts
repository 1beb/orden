import { beforeEach, describe, expect, it } from "vitest";
import {
  FONT_OPTIONS,
  DEFAULT_FONT_ID,
  fontOption,
  googleFontHref,
  applyFont,
} from "../src/fonts";

describe("font registry", () => {
  it("includes Atkinson Hyperlegible as a Google font", () => {
    const a = FONT_OPTIONS.find((f) => f.id === "atkinson");
    expect(a).toBeTruthy();
    expect(a!.google).toBe("Atkinson Hyperlegible");
    expect(a!.label).toBe("Atkinson Hyperlegible");
  });

  it("has a system default that is not a Google font", () => {
    expect(DEFAULT_FONT_ID).toBe("system");
    expect(fontOption("system").google).toBeUndefined();
  });

  it("falls back to the first option for an unknown id", () => {
    expect(fontOption("nope").id).toBe(FONT_OPTIONS[0].id);
  });

  it("googleFontHref builds a fonts.googleapis URL with the encoded family", () => {
    const href = googleFontHref(fontOption("atkinson"));
    expect(href).toContain("https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible");
    expect(href).toContain("display=swap");
  });

  it("googleFontHref returns null for a non-Google (system) font", () => {
    expect(googleFontHref(fontOption("system"))).toBeNull();
  });
});

describe("applyFont", () => {
  beforeEach(() => {
    document.documentElement.removeAttribute("style");
    document.querySelectorAll('link[id^="font-"]').forEach((l) => l.remove());
  });

  it("sets the --app-font and --font-scale CSS variables", () => {
    applyFont("atkinson", 18);
    const root = document.documentElement;
    expect(root.style.getPropertyValue("--app-font")).toContain("Atkinson Hyperlegible");
    // Base size 16px maps to scale 1, so 18px → 1.125 (see fonts.ts applyFont).
    expect(root.style.getPropertyValue("--font-scale")).toBe("1.125");
  });

  it("injects the Google Fonts <link> once (idempotent)", () => {
    applyFont("atkinson", 16);
    applyFont("atkinson", 20);
    expect(document.querySelectorAll('link[id="font-atkinson"]').length).toBe(1);
  });

  it("does not inject a link for the system font", () => {
    applyFont("system", 16);
    expect(document.querySelectorAll('link[id^="font-"]').length).toBe(0);
  });
});
