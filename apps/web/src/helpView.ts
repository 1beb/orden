// The help (?) main-panel view: documents every shortcut and doubles as the
// rebind surface. Click a row → it records the next chord (Esc cancels); a
// chord already held by another action is refused with an inline warning.
// Overrides persist to the vault via keybindings.ts; rows with an override get
// a Reset, and a footer button clears them all.
// Design: docs/plans/2026-06-10-keyboard-shortcuts-design.md.

import {
  KEY_ACTIONS,
  FIXED_KEYS,
  chordsFor,
  formatChord,
  chordFromEvent,
  isModifierOnly,
  actionForChord,
  setBinding,
  resetAllBindings,
  isOverridden,
} from "./keybindings";

// The one in-flight recording session (at most one row records at a time).
let recording: { actionId: string; stop: () => void } | null = null;

function stopRecording(): void {
  recording?.stop();
  recording = null;
}

export function renderHelp(container: HTMLElement): void {
  stopRecording();
  container.replaceChildren();

  const page = document.createElement("div");
  page.className = "settings-page help-page";

  const head = document.createElement("header");
  head.className = "settings-page-head";
  const title = document.createElement("h1");
  title.className = "settings-page-title";
  title.textContent = "Keyboard shortcuts";
  const close = document.createElement("button");
  close.className = "settings-close";
  close.id = "help-close";
  close.title = "Close help";
  close.setAttribute("aria-label", "Close help");
  close.textContent = "✕";
  head.append(title, close);
  page.append(head);

  const hint = document.createElement("p");
  hint.className = "help-hint";
  hint.textContent =
    "Click a shortcut to rebind it. While the terminal is focused, keys go to the agent — only the layout chords above pass through.";
  page.append(hint);

  // Rebindable actions, grouped.
  const groups = new Map<string, typeof KEY_ACTIONS[number][]>();
  for (const a of KEY_ACTIONS) {
    const list = groups.get(a.group) ?? [];
    list.push(a);
    groups.set(a.group, list);
  }

  for (const [group, actions] of groups) {
    const section = document.createElement("section");
    section.className = "settings-group";
    const h = document.createElement("h2");
    h.className = "settings-group-title";
    h.textContent = group;
    section.append(h);
    for (const a of actions) section.append(buildRow(a.id, a.label, container));
    page.append(section);
  }

  // Fixed reference rows (not rebindable).
  const fixed = document.createElement("section");
  fixed.className = "settings-group";
  const fh = document.createElement("h2");
  fh.className = "settings-group-title";
  fh.textContent = "Built-in";
  fixed.append(fh);
  for (const f of FIXED_KEYS) {
    const row = document.createElement("div");
    row.className = "help-row is-fixed";
    const label = document.createElement("span");
    label.className = "help-label";
    label.textContent = f.label;
    row.append(label, buildChips(f.chords));
    fixed.append(row);
  }
  page.append(fixed);

  const foot = document.createElement("div");
  foot.className = "help-foot";
  const resetAll = document.createElement("button");
  resetAll.className = "help-reset-all";
  resetAll.textContent = "Reset all to defaults";
  resetAll.addEventListener("click", () => {
    void resetAllBindings().then(() => renderHelp(container));
  });
  foot.append(resetAll);
  page.append(foot);

  container.append(page);
}

function buildChips(chords: readonly string[]): HTMLSpanElement {
  const wrap = document.createElement("span");
  wrap.className = "help-keys";
  chords.forEach((c, i) => {
    if (i > 0) {
      const sep = document.createElement("span");
      sep.className = "help-key-sep";
      sep.textContent = "or";
      wrap.append(sep);
    }
    const kbd = document.createElement("kbd");
    kbd.textContent = formatChord(c);
    wrap.append(kbd);
  });
  return wrap;
}

function buildRow(actionId: string, label: string, container: HTMLElement): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "help-row";
  row.dataset.actionId = actionId;

  const labelEl = document.createElement("span");
  labelEl.className = "help-label";
  labelEl.textContent = label;
  row.append(labelEl);

  const right = document.createElement("span");
  right.className = "help-right";
  right.append(buildChips(chordsFor(actionId)));

  if (isOverridden(actionId)) {
    const reset = document.createElement("button");
    reset.className = "help-reset";
    reset.textContent = "Reset";
    reset.title = "Restore the default shortcut";
    reset.addEventListener("click", (e) => {
      e.stopPropagation();
      void setBinding(actionId, null).then(() => renderHelp(container));
    });
    right.append(reset);
  }
  row.append(right);

  row.addEventListener("click", () => startRecording(row, actionId, container));
  return row;
}

function startRecording(row: HTMLDivElement, actionId: string, container: HTMLElement): void {
  if (recording?.actionId === actionId) return;
  stopRecording();

  row.classList.add("is-recording");
  const right = row.querySelector<HTMLElement>(".help-right")!;
  const saved = right.cloneNode(true) as HTMLElement;
  const prompt = document.createElement("span");
  prompt.className = "help-prompt";
  prompt.textContent = "Press a shortcut… (Esc cancels)";
  right.replaceChildren(prompt);

  const finish = (rerender: boolean): void => {
    document.removeEventListener("keydown", onKey, true);
    recording = null;
    if (rerender) {
      renderHelp(container);
    } else {
      row.classList.remove("is-recording");
      right.replaceChildren(...Array.from(saved.childNodes));
    }
  };

  const onKey = (e: KeyboardEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    if (e.code === "Escape") {
      finish(false);
      return;
    }
    if (isModifierOnly(e)) return; // wait for the full chord
    const chord = chordFromEvent(e);
    if (!chord) return;
    const holder = actionForChord(chord);
    if (holder && holder.id !== actionId) {
      prompt.textContent = `${formatChord(chord)} is taken by “${holder.label}” — press another, or Esc`;
      prompt.classList.add("is-conflict");
      return;
    }
    void setBinding(actionId, chord).then(() => finish(true));
  };

  document.addEventListener("keydown", onKey, true);
  recording = { actionId, stop: () => finish(false) };
}
