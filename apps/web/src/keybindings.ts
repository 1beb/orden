// User-adjustable keyboard shortcuts. Actions (id + label + default chords)
// are declared here; main.ts registers a handler per action and installs the
// single document-level dispatcher. Overrides live in the vault (ns
// "settings", key "keybindings") as { actionId: chords[] } holding only
// deviations from the defaults — so a future default change reaches existing
// vaults. Hydrate-at-boot + sync cache + write-through, like settings.ts.
//
// Chords are layout-independent: the key token comes from KeyboardEvent.code
// (the physical key), never .key — Shift would otherwise mutate the token
// ("\" → "|") and make "mod+shift+\" unmatchable. "mod" is Cmd on mac, Ctrl
// everywhere else. Design: docs/plans/2026-06-10-keyboard-shortcuts-design.md.

import type { Host } from "@orden/host-api";

export interface KeyAction {
  id: string;
  label: string;
  group: string;
  defaults: readonly string[];
}

export const KEY_ACTIONS: readonly KeyAction[] = [
  { id: "nav.toggle", label: "Toggle navigation", group: "Layout", defaults: ["mod+\\"] },
  { id: "sessions.toggle", label: "Toggle session pane", group: "Layout", defaults: ["mod+."] },
  {
    id: "context.toggle",
    label: "Toggle outline & annotations",
    group: "Layout",
    defaults: ["mod+'"],
  },
  { id: "focus.toggle", label: "Focus mode", group: "Layout", defaults: ["mod+shift+\\"] },
  { id: "search.open", label: "Search", group: "Search & commands", defaults: ["mod+k"] },
  {
    id: "palette.open",
    label: "Command palette",
    group: "Search & commands",
    defaults: ["mod+shift+p"],
  },
  {
    id: "help.toggle",
    label: "Keyboard shortcuts",
    group: "Help & settings",
    defaults: ["mod+/", "shift+/"],
  },
  { id: "settings.toggle", label: "Settings", group: "Help & settings", defaults: ["mod+,"] },
];

// Reference-only rows the help view shows; not dispatched or rebindable here.
export const FIXED_KEYS: readonly { label: string; chords: readonly string[] }[] = [
  { label: "Close view / dialog / palette", chords: ["escape"] },
  { label: "Save annotation note", chords: ["mod+enter"] },
  { label: "Undo / redo (editor)", chords: ["mod+z", "mod+y"] },
  { label: "Indent / unindent item (editor)", chords: ["tab", "shift+tab"] },
];

// --- Chord normalization ---------------------------------------------------

// KeyboardEvent.code → canonical key token. Letters/digits lowercase; the
// punctuation we bind maps to its unshifted US glyph; everything else keeps a
// lowercased code name ("enter", "arrowup", "f1").
const CODE_TOKENS: Record<string, string> = {
  Backslash: "\\",
  BracketLeft: "[",
  BracketRight: "]",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Quote: "'",
  Semicolon: ";",
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  Space: "space",
};

export function keyTokenFromCode(code: string): string {
  if (code in CODE_TOKENS) return CODE_TOKENS[code];
  if (code.startsWith("Key") && code.length === 4) return code.slice(3).toLowerCase();
  if (code.startsWith("Digit") && code.length === 6) return code.slice(5);
  return code.toLowerCase();
}

const MODIFIER_CODES = new Set([
  "ControlLeft",
  "ControlRight",
  "ShiftLeft",
  "ShiftRight",
  "AltLeft",
  "AltRight",
  "MetaLeft",
  "MetaRight",
]);

export function isModifierOnly(e: Pick<KeyboardEvent, "code">): boolean {
  return MODIFIER_CODES.has(e.code);
}

export const IS_MAC =
  typeof navigator !== "undefined" && /mac/i.test(navigator.platform ?? "");

type ChordEvent = Pick<KeyboardEvent, "code" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey">;

/**
 * Normalize a keydown into a canonical chord string ("mod+shift+\"), or null
 * for a bare-modifier press. `mod` is the platform primary (Cmd on mac, Ctrl
 * elsewhere); the OTHER one never matches a "mod" chord, so Ctrl+K on mac
 * stays free for the terminal.
 */
export function chordFromEvent(e: ChordEvent, isMac = IS_MAC): string | null {
  if (isModifierOnly(e)) return null;
  const parts: string[] = [];
  const mod = isMac ? e.metaKey : e.ctrlKey;
  const stray = isMac ? e.ctrlKey : e.metaKey;
  if (stray) return null; // not a chord we model; leave it alone
  if (mod) parts.push("mod");
  if (e.altKey) parts.push("alt");
  if (e.shiftKey) parts.push("shift");
  parts.push(keyTokenFromCode(e.code));
  return parts.join("+");
}

/** Canonical form of a stored chord (sorts modifiers, lowercases). */
export function normalizeChord(chord: string): string {
  const parts = chord.split("+").map((p) => p.trim().toLowerCase());
  const key = parts[parts.length - 1];
  const mods = new Set(parts.slice(0, -1));
  const out: string[] = [];
  if (mods.has("mod")) out.push("mod");
  if (mods.has("alt")) out.push("alt");
  if (mods.has("shift")) out.push("shift");
  out.push(key);
  return out.join("+");
}

// --- Display ----------------------------------------------------------------

// Shifted-glyph pairs we bind: show "shift+/" as "?" rather than "Shift+/".
const SHIFTED_GLYPHS: Record<string, string> = { "/": "?" };

/** Human-readable form of a chord, per platform ("Ctrl+\" / "⌘\"). */
export function formatChord(chord: string, isMac = IS_MAC): string {
  const parts = normalizeChord(chord).split("+");
  const key = parts[parts.length - 1];
  const mods = parts.slice(0, -1);
  if (mods.length === 1 && mods[0] === "shift" && key in SHIFTED_GLYPHS) {
    return SHIFTED_GLYPHS[key];
  }
  const out: string[] = mods.map((m) =>
    m === "mod" ? (isMac ? "⌘" : "Ctrl") : m === "shift" ? (isMac ? "⇧" : "Shift") : isMac ? "⌥" : "Alt",
  );
  out.push(key.length === 1 ? key.toUpperCase() : key[0].toUpperCase() + key.slice(1));
  return out.join(isMac ? "" : "+");
}

// --- Bindings store (vault-backed overrides over defaults) ------------------

export type Overrides = Record<string, string[]>;

let host: Host | null = null;
let overrides: Overrides = {};

function coerceOverrides(stored: unknown): Overrides {
  const out: Overrides = {};
  if (typeof stored !== "object" || stored === null) return out;
  const ids = new Set(KEY_ACTIONS.map((a) => a.id));
  for (const [id, v] of Object.entries(stored as Record<string, unknown>)) {
    if (!ids.has(id) || !Array.isArray(v)) continue;
    const chords = v.filter((c): c is string => typeof c === "string" && c.length > 0);
    if (chords.length > 0) out[id] = chords.map(normalizeChord);
  }
  return out;
}

/** Load overrides from the vault. Call at boot and on settings-feed changes. */
export async function hydrateKeybindings(h: Host): Promise<void> {
  host = h;
  overrides = coerceOverrides(await h.vault.get<unknown>("settings", "keybindings"));
}

/** Current chords for an action (override if present, else defaults). */
export function chordsFor(actionId: string): string[] {
  const o = overrides[actionId];
  if (o) return [...o];
  const a = KEY_ACTIONS.find((x) => x.id === actionId);
  return a ? a.defaults.map(normalizeChord) : [];
}

export function isOverridden(actionId: string): boolean {
  return actionId in overrides;
}

/** The action a chord is currently bound to, if any. */
export function actionForChord(chord: string): KeyAction | null {
  const c = normalizeChord(chord);
  for (const a of KEY_ACTIONS) {
    if (chordsFor(a.id).includes(c)) return a;
  }
  return null;
}

/** Rebind an action to a single chord (null = clear back to the default). */
export function setBinding(actionId: string, chord: string | null): Promise<void> {
  if (chord === null) delete overrides[actionId];
  else overrides[actionId] = [normalizeChord(chord)];
  return persist();
}

/** Drop every override. */
export function resetAllBindings(): Promise<void> {
  overrides = {};
  return persist();
}

function persist(): Promise<void> {
  return host ? host.vault.set("settings", "keybindings", overrides) : Promise.resolve();
}

// --- Dispatch ----------------------------------------------------------------

/** True when the event target is a place the user types (modifier-less chords
 * like "?" must not fire there). */
export function isTypingContext(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return target.closest('[contenteditable="true"], .ProseMirror, .xterm') !== null;
}

const handlers = new Map<string, () => void>();

/** Register the handler an action id dispatches to. */
export function onAction(actionId: string, fn: () => void): void {
  handlers.set(actionId, fn);
}

/** Resolve a keydown to a bound action id, honoring the typing guard. */
export function resolveEvent(e: ChordEvent & { target?: EventTarget | null }, isMac = IS_MAC): string | null {
  const chord = chordFromEvent(e, isMac);
  if (!chord) return null;
  const action = actionForChord(chord);
  if (!action) return null;
  const hasModifier = chord.includes("+") && chord.split("+").some((p) => p === "mod" || p === "alt");
  if (!hasModifier && isTypingContext(e.target ?? null)) return null;
  return action.id;
}

/** Install the single global dispatcher. Call once from main.ts. */
export function installKeybindings(doc: Document = document): void {
  doc.addEventListener("keydown", (e) => {
    const id = resolveEvent(e);
    if (!id) return;
    const fn = handlers.get(id);
    if (!fn) return;
    e.preventDefault();
    fn();
  });
}

/**
 * Should the terminal hand this keydown to the app instead of the pty?
 * Only chords that are BOUND and carry mod plus shift-or-punctuation pass —
 * mod+letter (Ctrl+K = readline kill-line) and bare keys ("?") stay with the
 * TUI. This also rescues mod+\ from sending SIGQUIT to the agent.
 */
export function terminalShouldYield(e: ChordEvent, isMac = IS_MAC): boolean {
  const chord = chordFromEvent(e, isMac);
  if (!chord || !actionForChord(chord)) return false;
  const parts = chord.split("+");
  if (!parts.includes("mod")) return false;
  const key = parts[parts.length - 1];
  return parts.includes("shift") || !/^[a-z0-9]$/.test(key);
}
