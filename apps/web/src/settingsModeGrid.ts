// The settings "default session mode" control: one row per agent tool
// (Claude Code, opencode) with a TUI/GUI/Tail segmented control, letting the
// user pick which surface new sessions of that tool open in. Each row is its own
// radio group, so exactly one mode is selected per tool. Kept as a pure
// builder — no settings/vault access — so it unit-tests without mounting the
// whole settings view. The settings wiring hydrates it from
// loadSettings().defaultMode and routes onChange through saveSettings.

import type { Settings, SessionMode } from "./settings";

type ModeMap = Settings["defaultMode"];

// [tool key, display label] pairs, one per row.
const TOOLS: readonly (readonly [keyof ModeMap, string])[] = [
  ["claude", "Claude Code"],
  ["opencode", "OpenCode"],
];

// [mode value, segment label] pairs, one per segment.
// "Tail" runs the real `claude` TUI in tmux (like TUI, on the subscription) but
// opens straight into the mirrored Chat surface — the jsonl tail rendered as a
// GUI — instead of the terminal. So it pairs subscription billing with the chat
// view, where "GUI" drives the Agent SDK (API-metered) and "TUI" shows the
// terminal. See sessionsPanel.ts surface routing + chatMount.ts mirror path.
const MODES: readonly (readonly [SessionMode, string])[] = [
  ["tui", "TUI"],
  ["gui", "GUI"],
  ["tail", "Tail"],
];

/**
 * Build the default-mode rows. `current` seeds the checked radio in each row;
 * `onChange` fires with the full, merged map whenever a segment is selected.
 */
export function buildModeGrid(current: ModeMap, onChange: (next: ModeMap) => void): HTMLElement {
  const wrap = document.createElement("div");

  for (const [tool, toolLabel] of TOOLS) {
    const row = document.createElement("div");
    row.className = "settings-row";

    const rowLabel = document.createElement("span");
    rowLabel.className = "settings-row-label";
    rowLabel.textContent = `${toolLabel} sessions`;
    row.append(rowLabel);

    const seg = document.createElement("span");
    seg.className = "settings-seg";
    seg.setAttribute("role", "radiogroup");
    seg.setAttribute("aria-label", `${toolLabel} default session mode`);

    for (const [mode, modeLabel] of MODES) {
      const cell = document.createElement("label");

      const input = document.createElement("input");
      input.type = "radio";
      input.name = `mode-${tool}`;
      input.value = mode;
      input.setAttribute("aria-label", `${toolLabel} ${modeLabel}`);
      input.checked = current[tool] === mode;
      input.addEventListener("change", () => {
        if (!input.checked) return;
        onChange({ ...current, [tool]: mode });
      });

      const text = document.createElement("span");
      text.textContent = modeLabel;

      cell.append(input, text);
      seg.append(cell);
    }

    row.append(seg);
    wrap.append(row);
  }

  return wrap;
}
