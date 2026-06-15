// The vault-change dispatch table — the multiplayer sync backbone. Every remote
// write (an agent over MCP, a host reactor, eventually another user) arrives as
// a (ns, key) change on the host feed; this router maps each namespace to the
// one handler that re-hydrates its store and re-renders the views that depend
// on it. main.ts registers today's namespaces (files, pages, cards, learnings,
// projects, docs, settings, sessions, feedback, ui); future cross-cutting
// features (presence, locks, org scoping) become new registrations, not edits
// to a closure.
//
// Unregistered namespaces are deliberately ignored — some (e.g. chat:<id>) have
// their own dedicated subscribers on the same feed.

export type VaultChangeHandler = (key: string, projectId?: string) => void | Promise<void>;

export interface VaultChangeRouter {
  /** Register the handler for one namespace. One handler per ns — a second
   * registration is a programming error and throws. */
  register(ns: string, handler: VaultChangeHandler): void;
  /** Route one change to its namespace handler (no-op when none is registered). */
  dispatch(ns: string, key: string, projectId?: string): Promise<void>;
}

export function createVaultChangeRouter(): VaultChangeRouter {
  const handlers = new Map<string, VaultChangeHandler>();
  return {
    register(ns, handler) {
      if (handlers.has(ns)) throw new Error(`vault-change handler already registered for "${ns}"`);
      handlers.set(ns, handler);
    },
    async dispatch(ns, key, projectId) {
      await handlers.get(ns)?.(key, projectId);
    },
  };
}
