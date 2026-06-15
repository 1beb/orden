import { beforeEach, describe, expect, it, vi } from "vitest";
import { createViewRegistry, createViewRouter, type ViewRouterDeps } from "../src/viewRegistry";
import type { View } from "../src/viewState";

function el(): HTMLElement {
  const e = document.createElement("section");
  document.body.append(e);
  return e;
}

function makeDeps(): ViewRouterDeps & {
  teardownText: ReturnType<typeof vi.fn>;
  teardownImage: ReturnType<typeof vi.fn>;
  persist: ReturnType<typeof vi.fn>;
} {
  return {
    viewArea: el(),
    htmlToggle: el(),
    syncPanelColumn: vi.fn(),
    renderBreadcrumb: vi.fn(),
    teardownText: vi.fn(),
    teardownImage: vi.fn(),
    refreshSourceSend: vi.fn(),
    persist: vi.fn(),
    afterNavigate: vi.fn(),
  };
}

describe("view registry + router", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it("activates only the current view's section and nav links", () => {
    const registry = createViewRegistry();
    const a = el();
    const b = el();
    const navA = el();
    navA.id = "nav-a";
    const bnA = el();
    bnA.id = "bn-a";
    const navB = el();
    navB.id = "nav-b";
    registry.register("journal" as View, {
      el: a,
      navLinks: ["#nav-a", "#bn-a"],
      breadcrumb: () => [],
    });
    registry.register("kanban" as View, { el: b, navLinks: ["#nav-b"], breadcrumb: () => [] });
    const route = createViewRouter(registry, makeDeps());

    route("kanban" as View);
    expect(a.classList.contains("active")).toBe(false);
    expect(b.classList.contains("active")).toBe(true);
    expect(navA.classList.contains("active")).toBe(false);
    expect(bnA.classList.contains("active")).toBe(false);
    expect(navB.classList.contains("active")).toBe(true);

    route("journal" as View);
    expect(a.classList.contains("active")).toBe(true);
    expect(b.classList.contains("active")).toBe(false);
    expect(navA.classList.contains("active")).toBe(true);
    expect(bnA.classList.contains("active")).toBe(true); // both nav links toggle together
    expect(navB.classList.contains("active")).toBe(false);
  });

  it("drives panel flags from the annotatable spec and runs onEnter", () => {
    const registry = createViewRegistry();
    const onEnter = vi.fn();
    registry.register("review" as View, { el: el(), breadcrumb: () => [], annotatable: true, onEnter });
    registry.register("kanban" as View, { el: el(), breadcrumb: () => [] });
    const deps = makeDeps();
    const route = createViewRouter(registry, deps);

    route("review" as View);
    expect(deps.viewArea.classList.contains("no-panel")).toBe(false);
    // review is annotatable but NOT a source view (its own Approve/Copy apply)
    expect(deps.viewArea.classList.contains("source-view")).toBe(false);
    expect(onEnter).toHaveBeenCalledOnce();

    route("kanban" as View);
    expect(deps.viewArea.classList.contains("no-panel")).toBe(true);
  });

  it("marks non-review annotatable viewers as source views", () => {
    const registry = createViewRegistry();
    registry.register("code" as View, { el: el(), breadcrumb: () => [], annotatable: true, textRealm: true });
    const deps = makeDeps();
    createViewRouter(registry, deps)("code" as View);
    expect(deps.viewArea.classList.contains("source-view")).toBe(true);
  });

  it("tears down annotators only when leaving their realm", () => {
    const registry = createViewRegistry();
    registry.register("code" as View, { el: el(), breadcrumb: () => [], textRealm: true });
    registry.register("html" as View, { el: el(), breadcrumb: () => [], textRealm: true });
    registry.register("image" as View, { el: el(), breadcrumb: () => [], imageRealm: true });
    registry.register("journal" as View, { el: el(), breadcrumb: () => [] });
    const deps = makeDeps();
    const route = createViewRouter(registry, deps);

    route("code" as View); // text realm: text annotator stays, image tears down
    expect(deps.teardownText).not.toHaveBeenCalled();
    expect(deps.teardownImage).toHaveBeenCalledTimes(1);

    route("html" as View); // still text realm: no text teardown
    expect(deps.teardownText).not.toHaveBeenCalled();

    route("image" as View); // leaving text realm for image realm
    expect(deps.teardownText).toHaveBeenCalledTimes(1);
    expect(deps.teardownImage).toHaveBeenCalledTimes(2);

    route("journal" as View); // neither realm: both tear down
    expect(deps.teardownText).toHaveBeenCalledTimes(2);
    expect(deps.teardownImage).toHaveBeenCalledTimes(3);
  });

  it("hides the html toggle unless the view keeps it", () => {
    const registry = createViewRegistry();
    registry.register("html" as View, { el: el(), breadcrumb: () => [], keepsHtmlToggle: true });
    registry.register("journal" as View, { el: el(), breadcrumb: () => [] });
    const deps = makeDeps();
    const route = createViewRouter(registry, deps);

    (deps.htmlToggle as HTMLElement & { hidden: boolean }).hidden = false;
    route("html" as View);
    expect((deps.htmlToggle as HTMLElement & { hidden: boolean }).hidden).toBe(false);
    route("journal" as View);
    expect((deps.htmlToggle as HTMLElement & { hidden: boolean }).hidden).toBe(true);
  });

  it("renders the view's breadcrumb and persists the view", () => {
    const registry = createViewRegistry();
    const crumbs = [{ label: "Kanban" }];
    registry.register("kanban" as View, { el: el(), breadcrumb: () => crumbs });
    const deps = makeDeps();
    createViewRouter(registry, deps)("kanban" as View);
    expect(deps.renderBreadcrumb).toHaveBeenCalledWith(crumbs);
    expect(deps.persist).toHaveBeenCalledWith("kanban");
  });

  it("rejects duplicate registrations and unknown views", () => {
    const registry = createViewRegistry();
    registry.register("kanban" as View, { el: el(), breadcrumb: () => [] });
    expect(() => registry.register("kanban" as View, { el: el(), breadcrumb: () => [] })).toThrow(
      /already registered/,
    );
    expect(() => registry.get("help" as View)).toThrow(/not registered/);
  });
});
