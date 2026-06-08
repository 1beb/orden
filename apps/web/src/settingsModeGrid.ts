// The settings "default session mode" control: a 2x2 grid letting the
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
  ["opencode", "OpenCode"],
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
  const table = document.createElement("table");
  table.className = "settings-mode-table";

  // Header row: a blank corner cell, then one column header per mode.
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  headRow.append(document.createElement("th")); // corner spacer
  for (const [, label] of MODES) {
    const th = document.createElement("th");
    th.scope = "col";
    th.className = "settings-mode-colhead";
    th.textContent = label;
    headRow.append(th);
  }
  thead.append(headRow);
  table.append(thead);

  const tbody = document.createElement("tbody");
  for (const [tool, toolLabel] of TOOLS) {
    const row = document.createElement("tr");

    const rowLabel = document.createElement("th");
    rowLabel.scope = "row";
    rowLabel.className = "settings-mode-rowlabel";
    rowLabel.textContent = toolLabel;
    row.append(rowLabel);

    for (const [mode, modeLabel] of MODES) {
      const cellTd = document.createElement("td");
      cellTd.className = "settings-mode-cell";

      const cell = document.createElement("label");

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
      cellTd.append(cell);
      row.append(cellTd);
    }

    tbody.append(row);
  }
  table.append(tbody);

  return table;
}
