import { describe, it, expect, beforeEach } from "vitest";
import {
  chordFromEvent,
  normalizeChord,
  formatChord,
  keyTokenFromCode,
  chordsFor,
  actionForChord,
  setBinding,
  resetAllBindings,
  isOverridden,
  hydrateKeybindings,
  resolveEvent,
  terminalShouldYield,
  isTypingContext,
  KEY_ACTIONS,
} from "../src/keybindings";
import type { Host } from "@orden/host-api";

function ev(code: string, mods: Partial<Record<"ctrl" | "meta" | "shift" | "alt", boolean>> = {}) {
  return {
    code,
    ctrlKey: !!mods.ctrl,
    metaKey: !!mods.meta,
    shiftKey: !!mods.shift,
    altKey: !!mods.alt,
  };
}

// A minimal vault-only host: get/set over an in-memory map.
function fakeHost(initial?: unknown): { host: Host; stored: () => unknown } {
  let value: unknown = initial;
  const vault = {
    get: async () => value,
    set: async (_ns: string, _key: string, v: unknown) => {
      value = v;
    },
  };
  return { host: { vault } as unknown as Host, stored: () => value };
}

beforeEach(async () => {
  await hydrateKeybindings(fakeHost().host);
});

describe("chordFromEvent", () => {
  it("uses the physical key, immune to shift mutation", () => {
    // Shift+\ produces key "|", but code stays Backslash.
    expect(chordFromEvent(ev("Backslash", { ctrl: true, shift: true }), false)).toBe(
      "mod+shift+\\",
    );
  });

  it("maps mod per platform", () => {
    expect(chordFromEvent(ev("KeyK", { ctrl: true }), false)).toBe("mod+k");
    expect(chordFromEvent(ev("KeyK", { meta: true }), true)).toBe("mod+k");
    // The off-platform primary is not a chord we model.
    expect(chordFromEvent(ev("KeyK", { ctrl: true }), true)).toBeNull();
    expect(chordFromEvent(ev("KeyK", { meta: true }), false)).toBeNull();
  });

  it("returns null for bare modifiers", () => {
    expect(chordFromEvent(ev("ShiftLeft", { shift: true }), false)).toBeNull();
  });

  it("builds ? as shift+/", () => {
    expect(chordFromEvent(ev("Slash", { shift: true }), false)).toBe("shift+/");
  });
});

describe("keyTokenFromCode", () => {
  it("maps letters, digits, punctuation, and named keys", () => {
    expect(keyTokenFromCode("KeyA")).toBe("a");
    expect(keyTokenFromCode("Digit3")).toBe("3");
    expect(keyTokenFromCode("Period")).toBe(".");
    expect(keyTokenFromCode("Quote")).toBe("'");
    expect(keyTokenFromCode("Enter")).toBe("enter");
  });
});

describe("normalizeChord", () => {
  it("sorts modifiers and lowercases", () => {
    expect(normalizeChord("Shift+Mod+P")).toBe("mod+shift+p");
  });
});

describe("formatChord", () => {
  it("renders platform modifiers", () => {
    expect(formatChord("mod+\\", false)).toBe("Ctrl+\\");
    expect(formatChord("mod+shift+\\", false)).toBe("Ctrl+Shift+\\");
    expect(formatChord("mod+k", true)).toBe("⌘K");
  });

  it("renders shift+/ as ?", () => {
    expect(formatChord("shift+/", false)).toBe("?");
    expect(formatChord("shift+/", true)).toBe("?");
  });
});

describe("bindings store", () => {
  it("serves defaults with no overrides", () => {
    expect(chordsFor("nav.toggle")).toEqual(["mod+\\"]);
    expect(chordsFor("help.toggle")).toEqual(["mod+/", "shift+/"]);
  });

  it("applies hydrated overrides and ignores junk", async () => {
    const { host } = fakeHost({
      "sessions.toggle": ["mod+;"],
      "not.an.action": ["mod+x"],
      "nav.toggle": "not-an-array",
    });
    await hydrateKeybindings(host);
    expect(chordsFor("sessions.toggle")).toEqual(["mod+;"]);
    expect(chordsFor("nav.toggle")).toEqual(["mod+\\"]);
  });

  it("setBinding persists only deviations; null restores the default", async () => {
    const { host, stored } = fakeHost();
    await hydrateKeybindings(host);
    await setBinding("sessions.toggle", "mod+;");
    expect(chordsFor("sessions.toggle")).toEqual(["mod+;"]);
    expect(isOverridden("sessions.toggle")).toBe(true);
    expect(stored()).toEqual({ "sessions.toggle": ["mod+;"] });
    await setBinding("sessions.toggle", null);
    expect(chordsFor("sessions.toggle")).toEqual(["mod+."]);
    expect(stored()).toEqual({});
  });

  it("resetAllBindings clears every override", async () => {
    const { host } = fakeHost();
    await hydrateKeybindings(host);
    await setBinding("nav.toggle", "mod+1");
    await resetAllBindings();
    expect(chordsFor("nav.toggle")).toEqual(["mod+\\"]);
  });
});

describe("actionForChord (conflict detection)", () => {
  it("finds the action holding a chord, respecting overrides", async () => {
    expect(actionForChord("mod+k")?.id).toBe("search.open");
    await setBinding("search.open", "mod+;");
    expect(actionForChord("mod+k")).toBeNull();
    expect(actionForChord("mod+;")?.id).toBe("search.open");
  });
});

describe("resolveEvent", () => {
  it("resolves modifier chords anywhere", () => {
    const input = document.createElement("input");
    expect(resolveEvent({ ...ev("Period", { ctrl: true }), target: input }, false)).toBe(
      "sessions.toggle",
    );
  });

  it("suppresses modifier-less chords while typing", () => {
    const input = document.createElement("input");
    expect(resolveEvent({ ...ev("Slash", { shift: true }), target: input }, false)).toBeNull();
    expect(
      resolveEvent({ ...ev("Slash", { shift: true }), target: document.body }, false),
    ).toBe("help.toggle");
  });
});

describe("isTypingContext", () => {
  it("flags inputs, contenteditable, ProseMirror, and xterm", () => {
    expect(isTypingContext(document.createElement("textarea"))).toBe(true);
    const pm = document.createElement("div");
    pm.className = "ProseMirror";
    const span = document.createElement("span");
    pm.append(span);
    document.body.append(pm);
    expect(isTypingContext(span)).toBe(true);
    expect(isTypingContext(document.body)).toBe(false);
    pm.remove();
  });
});

describe("terminalShouldYield", () => {
  it("yields bound mod+punctuation and mod+shift chords", () => {
    expect(terminalShouldYield(ev("Backslash", { ctrl: true }), false)).toBe(true);
    expect(terminalShouldYield(ev("Backslash", { ctrl: true, shift: true }), false)).toBe(true);
    expect(terminalShouldYield(ev("Comma", { ctrl: true }), false)).toBe(true);
  });

  it("keeps mod+letter, bare keys, and unbound chords with the TUI", () => {
    expect(terminalShouldYield(ev("KeyK", { ctrl: true }), false)).toBe(false); // bound but mod+letter
    expect(terminalShouldYield(ev("Slash", { shift: true }), false)).toBe(false); // "?" must type
    expect(terminalShouldYield(ev("KeyC", { ctrl: true }), false)).toBe(false); // SIGINT untouched
    expect(terminalShouldYield(ev("Semicolon", { ctrl: true }), false)).toBe(false); // unbound
  });
});

describe("KEY_ACTIONS defaults", () => {
  it("have no duplicate chords", () => {
    const all = KEY_ACTIONS.flatMap((a) => a.defaults.map(normalizeChord));
    expect(new Set(all).size).toBe(all.length);
  });
});
