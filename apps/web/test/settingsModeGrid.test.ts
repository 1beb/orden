import { describe, it, expect, vi } from "vitest";
import { buildModeGrid } from "../src/settingsModeGrid";
import type { Settings } from "../src/settings";

// Locate the radio input for a given tool/mode by its value + group name.
function radio(grid: HTMLElement, tool: string, mode: string): HTMLInputElement {
  const el = grid.querySelector<HTMLInputElement>(
    `input[type="radio"][name="mode-${tool}"][value="${mode}"]`,
  );
  if (!el) throw new Error(`no radio for ${tool}/${mode}`);
  return el;
}

describe("buildModeGrid", () => {
  const current: Settings["defaultMode"] = { claude: "gui", opencode: "tui" };

  it("reflects the current selection per row", () => {
    const grid = buildModeGrid(current, () => {});
    // Claude row: GUI checked, TUI not.
    expect(radio(grid, "claude", "gui").checked).toBe(true);
    expect(radio(grid, "claude", "tui").checked).toBe(false);
    // opencode row: TUI checked, GUI not.
    expect(radio(grid, "opencode", "tui").checked).toBe(true);
    expect(radio(grid, "opencode", "gui").checked).toBe(false);
  });

  it("renders two labelled rows and two mode columns", () => {
    const grid = buildModeGrid(current, () => {});
    expect(grid.textContent).toContain("Claude Code");
    expect(grid.textContent).toContain("OpenCode");
    expect(grid.textContent).toContain("TUI");
    expect(grid.textContent).toContain("GUI");
    // One radio group per tool, two radios each = four radios total.
    expect(grid.querySelectorAll('input[type="radio"]').length).toBe(4);
  });

  it("changing the Claude row to TUI emits the merged map", () => {
    const onChange = vi.fn();
    const grid = buildModeGrid(current, onChange);
    const tui = radio(grid, "claude", "tui");
    tui.checked = true;
    tui.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onChange).toHaveBeenCalledWith({ claude: "tui", opencode: "tui" });
  });

  it("changing the opencode row to GUI emits the merged map", () => {
    const onChange = vi.fn();
    const grid = buildModeGrid(current, onChange);
    const gui = radio(grid, "opencode", "gui");
    gui.checked = true;
    gui.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onChange).toHaveBeenCalledWith({ claude: "gui", opencode: "gui" });
  });
});
