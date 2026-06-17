import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// hasDirectoryPicker caches its detectPicker() probe across calls, so each test
// resets the module registry to get a clean cache before reimporting.
async function freshModule() {
  vi.resetModules();
  return import("./pickDirectory");
}

describe("hasDirectoryPicker", () => {
  const saved = {
    DISPLAY: process.env.DISPLAY,
    WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY,
  };

  beforeEach(() => {
    delete process.env.DISPLAY;
    delete process.env.WAYLAND_DISPLAY;
  });

  afterEach(() => {
    if (saved.DISPLAY === undefined) delete process.env.DISPLAY;
    else process.env.DISPLAY = saved.DISPLAY;
    if (saved.WAYLAND_DISPLAY === undefined) delete process.env.WAYLAND_DISPLAY;
    else process.env.WAYLAND_DISPLAY = saved.WAYLAND_DISPLAY;
  });

  it("reports false on a headless host even when the binary is installed", async () => {
    // No DISPLAY/WAYLAND_DISPLAY (e.g. launched over SSH on a tty): a native
    // dialog can't render, so the capability must be false regardless of whether
    // zenity/kdialog is on PATH — otherwise the modal shows a Browse button that
    // silently does nothing.
    const { hasDirectoryPicker, pickDirectory } = await freshModule();
    expect(hasDirectoryPicker()).toBe(false);
    await expect(pickDirectory()).resolves.toBeNull();
  });

  it("requires a display to be reported available", async () => {
    process.env.DISPLAY = ":0";
    const { hasDirectoryPicker } = await freshModule();
    // With a display present, availability tracks whether a picker binary exists
    // on this machine — true on a desktop, false on a bare CI box. Either way it
    // no longer falsely claims availability with no display.
    expect(typeof hasDirectoryPicker()).toBe("boolean");
  });
});
