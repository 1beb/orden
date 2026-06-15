import { describe, expect, it } from "vitest";
import { createViewStore } from "../src/viewState";
import { makeViewToggler } from "../src/viewToggler";

describe("view toggler", () => {
  it("opens the overlay, remembering the view it came from", () => {
    const store = createViewStore("journal");
    const settings = makeViewToggler(store, "settings");

    settings.toggle();

    expect(store.get()).toBe("settings");
    expect(settings.isOpen()).toBe(true);
  });

  it("toggling again restores the prior view", () => {
    const store = createViewStore("kanban");
    const settings = makeViewToggler(store, "settings");

    settings.toggle();
    settings.toggle();

    expect(store.get()).toBe("kanban");
    expect(settings.isOpen()).toBe(false);
  });

  it("close() restores the prior view when the overlay is open", () => {
    const store = createViewStore("pages");
    const help = makeViewToggler(store, "help");

    help.toggle();
    help.close();

    expect(store.get()).toBe("pages");
  });

  it("close() is a no-op when the overlay is not the active view", () => {
    // The Escape handler calls close() on every overlay toggler; the ones that
    // aren't open must not hijack the view.
    const store = createViewStore("journal");
    const settings = makeViewToggler(store, "settings");
    const help = makeViewToggler(store, "help");

    help.toggle(); // help is open, settings is not
    settings.close(); // must not steal the view

    expect(store.get()).toBe("help");
  });

  it("remembers the latest prior view on each open, not a stale one", () => {
    const store = createViewStore("journal");
    const settings = makeViewToggler(store, "settings");

    settings.toggle(); // from journal
    settings.toggle(); // back to journal
    store.set("kanban"); // user navigates elsewhere
    settings.toggle(); // open from kanban now
    settings.close();

    expect(store.get()).toBe("kanban");
  });
});
