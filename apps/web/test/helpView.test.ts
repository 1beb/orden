import { describe, it, expect, beforeEach } from "vitest";
import { renderHelp } from "../src/helpView";
import { hydrateKeybindings, chordsFor } from "../src/keybindings";
import type { Host } from "@orden/host-api";

function fakeHost(): Host {
  let value: unknown;
  return {
    vault: {
      get: async () => value,
      set: async (_ns: string, _key: string, v: unknown) => {
        value = v;
      },
    },
  } as unknown as Host;
}

function key(code: string, mods: Partial<Record<"ctrl" | "shift", boolean>> = {}): KeyboardEvent {
  return new KeyboardEvent("keydown", {
    code,
    ctrlKey: !!mods.ctrl,
    shiftKey: !!mods.shift,
    bubbles: true,
    cancelable: true,
  });
}

// Wait a macrotask so setBinding's promise chain (then → re-render) settles.
const settle = () => new Promise((r) => setTimeout(r, 0));

let container: HTMLElement;

beforeEach(async () => {
  await hydrateKeybindings(fakeHost());
  container = document.createElement("div");
  document.body.append(container);
  renderHelp(container);
});

function rowFor(actionId: string): HTMLElement {
  const row = container.querySelector<HTMLElement>(`[data-action-id="${actionId}"]`);
  if (!row) throw new Error(`no row for ${actionId}`);
  return row;
}

describe("renderHelp", () => {
  it("renders a row per action with its chords, plus fixed rows", () => {
    expect(container.querySelectorAll("[data-action-id]").length).toBe(8);
    expect(rowFor("nav.toggle").querySelector("kbd")?.textContent).toBe("Ctrl+\\");
    expect(container.querySelectorAll(".help-row.is-fixed").length).toBeGreaterThan(0);
  });

  it("records a rebind on click + keydown", async () => {
    rowFor("sessions.toggle").click();
    expect(container.querySelector(".help-prompt")).toBeTruthy();
    document.dispatchEvent(key("Semicolon", { ctrl: true }));
    await settle();
    expect(chordsFor("sessions.toggle")).toEqual(["mod+;"]);
    expect(rowFor("sessions.toggle").querySelector("kbd")?.textContent).toBe("Ctrl+;");
    expect(rowFor("sessions.toggle").querySelector(".help-reset")).toBeTruthy();
  });

  it("refuses a chord held by another action", async () => {
    rowFor("sessions.toggle").click();
    document.dispatchEvent(key("KeyK", { ctrl: true })); // search.open's chord
    await settle();
    const prompt = container.querySelector(".help-prompt");
    expect(prompt?.textContent).toContain("taken by");
    expect(chordsFor("sessions.toggle")).toEqual(["mod+."]);
  });

  it("cancels recording on Escape", async () => {
    rowFor("nav.toggle").click();
    document.dispatchEvent(key("Escape"));
    await settle();
    expect(container.querySelector(".help-prompt")).toBeNull();
    expect(chordsFor("nav.toggle")).toEqual(["mod+\\"]);
  });

  it("reset still works after a cancelled recording (no dead cloned buttons)", async () => {
    rowFor("sessions.toggle").click();
    document.dispatchEvent(key("Semicolon", { ctrl: true }));
    await settle();
    // Start recording again, cancel — the row must come back fully wired.
    rowFor("sessions.toggle").click();
    document.dispatchEvent(key("Escape"));
    await settle();
    rowFor("sessions.toggle").querySelector<HTMLButtonElement>(".help-reset")!.click();
    await settle();
    expect(chordsFor("sessions.toggle")).toEqual(["mod+."]);
  });

  it("reset restores the default", async () => {
    rowFor("sessions.toggle").click();
    document.dispatchEvent(key("Semicolon", { ctrl: true }));
    await settle();
    rowFor("sessions.toggle").querySelector<HTMLButtonElement>(".help-reset")!.click();
    await settle();
    expect(chordsFor("sessions.toggle")).toEqual(["mod+."]);
  });
});
