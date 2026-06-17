// The settings "default model" control: one row per agent tool (Claude Code,
// opencode) with a <select> dropdown of available models. Kept as a pure builder
// — no settings/vault access — so it unit-tests without mounting the whole
// settings view. The settings wiring populates it from host.chat.listModels and
// routes onChange through saveSettings.

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
 * `models` provides the available model list per tool; `onChange` fires with the
 * full, merged map whenever the user picks a model.
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

    const models = modelsByTool[tool] ?? [];
    for (const m of models) {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.label;
      if (current[tool] === m.id) opt.selected = true;
      select.append(opt);
    }

    // If the stored model id isn't in the list anymore (e.g. model was removed),
    // still select nothing so the user can see it's fallen back to Default.
    select.value = current[tool];

    select.addEventListener("change", () => {
      onChange({ ...current, [tool]: select.value });
    });

    row.append(select);
    wrap.append(row);
  }

  return wrap;
}
