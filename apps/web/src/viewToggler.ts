// The overlay-view seam — Settings and Help. These are center views you open
// over your work and then return to where you were: opening remembers the prior
// view, and closing (the ✕ or Escape) restores it. The remember-then-restore
// state machine lived inline and duplicated per overlay; makeViewToggler is the
// one place it lives now. The DOM wiring stays at the call site because it
// varies (the cog needs stopPropagation, Help's ✕ is re-created each render and
// must be delegated), but the state machine does not — so a future third
// overlay is one makeViewToggler call plus its button wiring, matching the
// view-registry / vault-change-router / settings-binder seams.
//
// Escape-to-close is global: the handler calls close() on every toggler, and
// close() is a no-op unless that overlay is the active view (only one can be).

import type { View, ViewStore } from "./viewState";

export interface ViewToggler {
  /** Open the overlay (remembering the current view) if it's closed, or close
   *  it (restoring the remembered view) if it's the active view. */
  toggle(): void;
  /** Close the overlay, restoring the view active when it opened. No-op when
   *  this overlay isn't the active view. */
  close(): void;
  /** True when this overlay is the active view. */
  isOpen(): boolean;
}

export function makeViewToggler(store: ViewStore, view: View): ViewToggler {
  let priorView: View = store.get();
  return {
    toggle() {
      if (store.get() === view) {
        store.set(priorView);
      } else {
        priorView = store.get();
        store.set(view);
      }
    },
    close() {
      if (store.get() === view) store.set(priorView);
    },
    isOpen() {
      return store.get() === view;
    },
  };
}
