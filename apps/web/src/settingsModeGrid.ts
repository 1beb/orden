// The settings-popover "default session mode" control: a 2x2 grid letting the
// user pick, per agent tool, whether new sessions open as a TUI (the terminal)
// or a GUI (the native chat). Two rows (Claude Code, opencode), two columns
// (TUI, GUI); each row is its own radio group, so exactly one mode is selected
// per tool. Kept as a pure builder — no settings/vault access — so it unit-tests
// without mounting the whole popover. The popover render hydrates it from
// loadSettings().defaultMode and routes onChange through saveSettings.

import type { Settings, SessionMode } from "./settings";

type ModeMap = Settings["defaultMode"];

// [tool key, display label] pairs, one per row.
const TOOLS: readonly (readonly [keyof ModeMap, string])[] = [
  ["claude", "Claude Code"],
  ["opencode", "opencode"],
];

// [mode value, column header] pairs, one per column.
const MODES: readonly (readonly [SessionMode, string])[] = [
  ["tui", "TUI"],
  ["gui", "GUI"],
];

/**
 * Build the default-mode grid. `current` seeds the checked radio in each row;
 * `onChange` fires with the full, merged map whenever a cell is selected.
 */
export function buildModeGrid(current: ModeMap, onChange: (next: ModeMap) => void): HTMLElement {
  const grid = document.createElement("div");
  grid.className = "settings-mode-grid";

  // Column header row: a blank corner cell, then one header per mode.
  const head = document.createElement("div");
  head.className = "settings-mode-row settings-mode-head";
  head.append(document.createElement("span")); // corner spacer
  for (const [, label] of MODES) {
    const h = document.createElement("span");
    h.className = "settings-mode-colhead";
    h.textContent = label;
    head.append(h);
  }
  grid.append(head);

  for (const [tool, toolLabel] of TOOLS) {
    const row = document.createElement("div");
    row.className = "settings-mode-row";

    const rowLabel = document.createElement("span");
    rowLabel.className = "settings-mode-rowlabel";
    rowLabel.textContent = toolLabel;
    row.append(rowLabel);

    for (const [mode, modeLabel] of MODES) {
      const cell = document.createElement("label");
      cell.className = "settings-mode-cell";

      const input = document.createElement("input");
      input.type = "radio";
      input.name = `mode-${tool}`;
      input.value = mode;
      // The cell label wraps only the radio (no visible text), so give screen
      // readers a name beyond the raw value, e.g. "Claude Code GUI".
      input.setAttribute("aria-label", `${toolLabel} ${modeLabel}`);
      input.checked = current[tool] === mode;
      input.addEventListener("change", () => {
        if (!input.checked) return;
        onChange({ ...current, [tool]: mode });
      });

      cell.append(input);
      row.append(cell);
    }

    grid.append(row);
  }

  return grid;
}
