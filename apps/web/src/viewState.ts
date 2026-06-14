export type View =
  | "review"
  | "code"
  | "image"
  | "html"
  | "journal"
  | "kanban"
  | "pages"
  | "projects"
  | "project"
  | "settings"
  | "learnings"
  | "help";

export interface ViewStore {
  get(): View;
  set(v: View): void;
  /** Subscribe to view changes. Returns an unsubscribe function. */
  subscribe(fn: (v: View) => void): () => void;
}

/**
 * A framework-agnostic store for the active center view.
 *
 * `set` always notifies every current subscriber synchronously with the new
 * value — even when the value is unchanged. Callers that only care about
 * actual transitions should compare against the previous value themselves.
 */
export function createViewStore(initial: View): ViewStore {
  let current: View = initial;
  const listeners = new Set<(v: View) => void>();

  return {
    get() {
      return current;
    },
    set(v: View) {
      current = v;
      // Snapshot so unsubscribing during notification can't skip listeners.
      for (const fn of [...listeners]) {
        fn(current);
      }
    },
    subscribe(fn: (v: View) => void) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}
