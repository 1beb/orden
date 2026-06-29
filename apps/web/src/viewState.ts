export type View =
  | "review"
  | "code"
  | "image"
  | "html"
  | "journal"
  | "kanban"
  | "pages"
  | "workflows"
  | "projects"
  | "project"
  | "project-settings"
  | "settings"
  | "learnings"
  | "help";

// Authoritative list of every center view. Kept beside the `View` union so the
// two can't drift; the URL router validates incoming deep-link targets against
// it (an unknown view string is ignored, never restored as a bogus view).
export const VIEWS: readonly View[] = [
  "review",
  "code",
  "image",
  "html",
  "journal",
  "kanban",
  "pages",
  "workflows",
  "projects",
  "project",
  "project-settings",
  "settings",
  "learnings",
  "help",
];

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
