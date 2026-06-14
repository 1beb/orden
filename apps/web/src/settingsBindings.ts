// Generic settings-control binders: every settings control follows the same
// shape (read the saved value into the control, write changes through
// saveSettings, optionally refresh a dependent surface). These helpers keep
// that shape in ONE place — when settings later split into scopes (org /
// project / user), the scope resolution lands here instead of in every
// call site.

import { loadSettings, saveSettings, type Settings } from "./settings";

// Keys whose value matches the control type, so a binder can't be pointed at
// a setting of the wrong shape.
type KeyOf<T> = { [K in keyof Settings]: Settings[K] extends T ? K : never }[keyof Settings];

/** Bind a checkbox to a boolean setting. `onChange` runs after the (cached)
 * save, so dependent refreshes read the new value via loadSettings(). Missing
 * elements are skipped — some controls only exist on certain hosts. */
export function bindCheckbox(id: string, key: KeyOf<boolean>, onChange?: () => void): void {
  const cb = document.querySelector<HTMLInputElement>(`#${id}`);
  if (!cb) return;
  cb.checked = loadSettings()[key];
  cb.addEventListener("change", () => {
    void saveSettings({ [key]: cb.checked });
    onChange?.();
  });
}

/** Bind a select to a string setting, accepting only the listed values (a
 * stale or tampered option value is ignored rather than persisted). */
export function bindSelect<K extends KeyOf<string>>(
  id: string,
  key: K,
  allowed: readonly Settings[K][],
  onChange?: () => void,
): void {
  const sel = document.querySelector<HTMLSelectElement>(`#${id}`);
  if (!sel) return;
  sel.value = loadSettings()[key];
  sel.addEventListener("change", () => {
    const v = sel.value as Settings[K];
    if (!allowed.includes(v)) return;
    void saveSettings({ [key]: v } as Partial<Settings>);
    onChange?.();
  });
}

/** Bind a radio group (by input name, within `root`) to a setting, mapping
 * each radio's string value through `parse` (identity for string settings,
 * Number for numeric ones). */
export function bindRadios<K extends keyof Settings>(
  root: ParentNode,
  name: string,
  key: K,
  parse: (value: string) => Settings[K],
  onChange?: () => void,
): void {
  for (const radio of root.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`)) {
    radio.checked = parse(radio.value) === loadSettings()[key];
    radio.addEventListener("change", () => {
      if (!radio.checked) return;
      void saveSettings({ [key]: parse(radio.value) } as Partial<Settings>);
      onChange?.();
    });
  }
}
