// The view registry + router: each center view registers ONE self-describing
// spec (its DOM section, breadcrumb, annotation surfaces, nav links, render
// hook), and a single router applies every cross-cutting rule on each
// transition. This replaces the switch blocks that used to spread one view
// across three places in main.ts (CSS toggles, breadcrumb switch, teardown
// guards) — adding a view (e.g. a future team dashboard or org-admin panel) is
// one registration, not surgery.

import type { View } from "./viewState";

export interface Crumb {
  label: string;
  go?: () => void;
}

export interface ViewSpec {
  /** The view's DOM section; the router toggles `.active` across all of them. */
  el: HTMLElement;
  /** Location breadcrumb segments for this view (computed per render). */
  breadcrumb: () => Crumb[];
  /** Content can carry annotations — the annotations panel shows only here. */
  annotatable?: boolean;
  /** Hosts the TEXT annotator (code/html): entering any non-text view tears
   * the active text annotator down; moving between text views keeps it. */
  textRealm?: boolean;
  /** Hosts the IMAGE annotator: same keep/teardown rule as textRealm. */
  imageRealm?: boolean;
  /** Keeps the topbar Rendered/Source toggle visible (html/code viewers). */
  keepsHtmlToggle?: boolean;
  /** Selectors of the nav links (left-nav and/or bottom-nav) to mark active
   * while this view is shown — the router clears them on every other view. */
  navLinks?: readonly string[];
  /** Render/refresh work when the view becomes active (runs after teardowns). */
  onEnter?: () => void;
}

export interface ViewRegistry {
  register(view: View, spec: ViewSpec): void;
  get(view: View): ViewSpec;
  entries(): readonly (readonly [View, ViewSpec])[];
}

export function createViewRegistry(): ViewRegistry {
  const specs = new Map<View, ViewSpec>();
  return {
    register(view, spec) {
      if (specs.has(view)) throw new Error(`view "${view}" already registered`);
      specs.set(view, spec);
    },
    get(view) {
      const spec = specs.get(view);
      if (!spec) throw new Error(`view "${view}" not registered`);
      return spec;
    },
    entries() {
      return [...specs.entries()];
    },
  };
}

// Cross-cutting collaborators the router drives on every transition. These are
// app-level singletons (panel layout, annotator teardown, persistence), not
// per-view concerns — per-view behavior belongs on the ViewSpec.
export interface ViewRouterDeps {
  /** The center column wrapper carrying the panel/source-view CSS flags. */
  viewArea: HTMLElement;
  /** The topbar Rendered/Source button (hidden outside html/code viewers). */
  htmlToggle: HTMLElement;
  /** Re-place the context panel for the new view's panel visibility. */
  syncPanelColumn: () => void;
  /** Paint the location breadcrumb (hides itself when there's nothing to show). */
  renderBreadcrumb: (crumbs: Crumb[]) => void;
  /** Tear down the active text annotator + highlights (idempotent). */
  teardownText: () => void;
  /** Tear down the active image annotator (idempotent). */
  teardownImage: () => void;
  /** Re-gate the source-view Send button for the new view. */
  refreshSourceSend: () => void;
  /** Persist the view so a reload restores it. */
  persist: (v: View) => void;
  /** Post-navigation hook (e.g. close the mobile nav drawer). */
  afterNavigate: () => void;
}

/**
 * Build the single viewStore subscriber. The order of operations mirrors the
 * historical inline closure: activate sections + nav links, sync panel flags +
 * breadcrumb, hide the html toggle, tear down annotators the new view doesn't
 * host, run the view's own onEnter, then re-gate the Send button and persist.
 */
export function createViewRouter(registry: ViewRegistry, deps: ViewRouterDeps): (v: View) => void {
  return (v) => {
    const spec = registry.get(v);
    for (const [name, s] of registry.entries()) {
      s.el.classList.toggle("active", name === v);
      for (const sel of s.navLinks ?? []) {
        document.querySelector(sel)?.classList.toggle("active", name === v);
      }
    }
    deps.viewArea.classList.toggle("no-panel", !spec.annotatable);
    // The review Approve/Copy buttons act on the ProseMirror review doc; hide
    // them on the other annotatable viewers (code/image/html) so they can't
    // deliver the wrong (stale review) annotations.
    deps.viewArea.classList.toggle("source-view", !!spec.annotatable && v !== "review");
    // Only the HTML viewer carries its own extracted outline; clear the flag on
    // every transition so a stale one can't leak onto code/image. showHtmlFile
    // re-sets it once the iframe loads and headings are found.
    if (v !== "html") deps.viewArea.classList.remove("has-outline");
    deps.syncPanelColumn();
    deps.renderBreadcrumb(spec.breadcrumb());
    // The Rendered/Source toggle only belongs to file viewers; hide it when we
    // navigate anywhere else. (Viewers un-hide it themselves on file open.)
    if (!spec.keepsHtmlToggle) deps.htmlToggle.hidden = true;
    // Annotator lifecycle: leaving a realm tears its annotator down — moving
    // BETWEEN views of the same realm (code <-> html) keeps it alive.
    if (!spec.textRealm) deps.teardownText();
    if (!spec.imageRealm) deps.teardownImage();
    spec.onEnter?.();
    deps.refreshSourceSend();
    deps.persist(v);
    deps.afterNavigate();
  };
}
