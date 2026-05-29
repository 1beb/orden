import { describe, it, expect, vi } from "vitest";
import { createViewStore } from "../src/viewState";

describe("createViewStore", () => {
  it("returns the initial value via get", () => {
    const store = createViewStore("review");
    expect(store.get()).toBe("review");
  });

  it("set updates the current value", () => {
    const store = createViewStore("review");
    store.set("journal");
    expect(store.get()).toBe("journal");
  });

  it("notifies a subscriber with the new value on set", () => {
    const store = createViewStore("review");
    const fn = vi.fn();
    store.subscribe(fn);
    store.set("kanban");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("kanban");
  });

  it("notifies even when the value is unchanged", () => {
    const store = createViewStore("review");
    const fn = vi.fn();
    store.subscribe(fn);
    store.set("review");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("review");
  });

  it("unsubscribe stops further notifications", () => {
    const store = createViewStore("review");
    const fn = vi.fn();
    const unsubscribe = store.subscribe(fn);
    store.set("journal");
    expect(fn).toHaveBeenCalledTimes(1);
    unsubscribe();
    store.set("kanban");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("notifies all subscribers", () => {
    const store = createViewStore("review");
    const a = vi.fn();
    const b = vi.fn();
    store.subscribe(a);
    store.subscribe(b);
    store.set("journal");
    expect(a).toHaveBeenCalledWith("journal");
    expect(b).toHaveBeenCalledWith("journal");
  });

  it("does not notify a subscriber added after a set", () => {
    const store = createViewStore("review");
    store.set("journal");
    const fn = vi.fn();
    store.subscribe(fn);
    expect(fn).not.toHaveBeenCalled();
  });

  it("unsubscribing one subscriber leaves others active", () => {
    const store = createViewStore("review");
    const a = vi.fn();
    const b = vi.fn();
    const unsubA = store.subscribe(a);
    store.subscribe(b);
    unsubA();
    store.set("kanban");
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledWith("kanban");
  });
});
