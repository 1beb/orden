// The settings "default model" control: one row per agent tool (Claude Code,
// opencode) with a <select> of available models, letting the user pin which
// model new sessions of that tool launch with. Kept as a pure builder — no
// settings/vault access — so it unit-tests without mounting the whole settings
// view. The settings wiring populates `modelsByTool` from host.chat.listModels
// and routes onChange through saveSettings. Mirrors settingsModeGrid.ts.

import type { ModelOption } from "@orden/chat-core";
import type { Settings } from "./settings";

type ModelMap = Settings["defaultModel"];

// [tool key, display label] pairs, one per row.
const TOOLS: readonly (readonly [keyof ModelMap, string])[] = [
  ["claude", "Claude Code"],
  ["opencode", "OpenCode"],
];

/**
 * Build the default-model rows. `current` seeds the selected option in each row;
 * `modelsByTool` provides the available model list per tool (empty until the
 * host's catalog loads); `onChange` fires with the full, merged map whenever the
 * user picks a model. The leading "Default" option (value "") means "use the
 * agent's own default".
 */
export function buildModelGrid(
  current: ModelMap,
  modelsByTool: Record<keyof ModelMap, ModelOption[]>,
  onChange: (next: ModelMap) => void,
): HTMLElement {
  const wrap = document.createElement("div");

  for (const [tool, toolLabel] of TOOLS) {
    const row = document.createElement("div");
    row.className = "settings-row";

    const rowLabel = document.createElement("span");
    rowLabel.className = "settings-row-label";
    rowLabel.textContent = `${toolLabel} model`;
    row.append(rowLabel);

    const select = document.createElement("select");
    select.className = "settings-select";
    select.setAttribute("aria-label", `${toolLabel} default model`);

    const defaultOpt = document.createElement("option");
    defaultOpt.value = "";
    defaultOpt.textContent = "Default";
    select.append(defaultOpt);

    for (const m of modelsByTool[tool] ?? []) {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.label;
      select.append(opt);
    }

    // Select the stored id when present in the list; an id no longer offered
    // leaves the select on "Default" so the fallback is visible.
    select.value = current[tool];

    select.addEventListener("change", () => {
      onChange({ ...current, [tool]: select.value });
    });

    row.append(select);
    wrap.append(row);
  }

  return wrap;
}
