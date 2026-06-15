import { beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserHost } from "../src/host/browserHost";
import { hydrateSettings, loadSettings } from "../src/settings";
import { bindCheckbox, bindRadios, bindSelect } from "../src/settingsBindings";

function change(el: HTMLElement): void {
  el.dispatchEvent(new Event("change"));
}

describe("settings binders", () => {
  beforeEach(async () => {
    localStorage.clear();
    document.body.replaceChildren();
    await hydrateSettings(new BrowserHost());
  });

  it("bindCheckbox reads the saved value and writes changes through", () => {
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.id = "show-archived";
    document.body.append(cb);
    const refresh = vi.fn();

    bindCheckbox("show-archived", "showArchived", refresh);
    expect(cb.checked).toBe(false); // the default

    cb.checked = true;
    change(cb);
    expect(loadSettings().showArchived).toBe(true);
    // onChange runs after the cached save, so it can read the new value.
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("bindCheckbox skips a missing element", () => {
    expect(() => bindCheckbox("no-such-control", "showArchived")).not.toThrow();
  });

  it("bindSelect persists only allowed values", () => {
    const sel = document.createElement("select");
    sel.id = "pr-forge";
    for (const v of ["auto", "gh", "bogus"]) {
      const o = document.createElement("option");
      o.value = v;
      sel.append(o);
    }
    document.body.append(sel);

    bindSelect("pr-forge", "prForge", ["auto", "gh", "glab", "none"]);
    expect(sel.value).toBe("auto");

    sel.value = "gh";
    change(sel);
    expect(loadSettings().prForge).toBe("gh");

    sel.value = "bogus";
    change(sel);
    expect(loadSettings().prForge).toBe("gh"); // tampered option ignored
  });

  it("bindRadios checks the saved value and parses on change", () => {
    const root = document.createElement("div");
    for (const v of ["1", "4", "8"]) {
      const r = document.createElement("input");
      r.type = "radio";
      r.name = "complete-fade";
      r.value = v;
      root.append(r);
    }
    document.body.append(root);
    const onChange = vi.fn();

    bindRadios(root, "complete-fade", "completeFadeHours", Number, onChange);
    const radios = [...root.querySelectorAll<HTMLInputElement>("input")];
    expect(radios.find((r) => r.checked)?.value).toBe("1"); // default 1h

    radios[2].checked = true;
    change(radios[2]);
    expect(loadSettings().completeFadeHours).toBe(8);
    expect(onChange).toHaveBeenCalledOnce();
  });
});
