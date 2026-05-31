// Reacting to the MCP `panel_open` tool: it writes the `ui/panel-intent` vault
// record `{ kind, target, nonce }` so an agent can steer the main panel. This
// module turns that record into a navigation action. Extracted from main.ts so
// the dispatch can be unit-tested without the editor/DOM.

export type PanelIntentKind = "doc" | "page" | "kanban" | "card";

export interface PanelIntent {
  kind: string;
  target: string;
}

export interface PanelIntentDeps {
  // Open a repo markdown path in the review view.
  openRepoFile: (path: string) => void;
  // Show a wiki page in the journal view.
  openPage: (name: string) => void;
  // Switch to the kanban view and re-render the board.
  openKanban: () => void;
  // Open a specific card by id; return false if the id didn't resolve so the
  // caller can fall back to just showing the board.
  openCard: (id: string) => boolean;
  // Resolve a card target (id or case-insensitive title) to a card id.
  resolveCardId: (target: string) => string | undefined;
}

// Route a panel-open intent to the matching navigation action. Returns true if
// the intent was handled (a known kind), false otherwise.
export function dispatchPanelIntent(intent: PanelIntent, deps: PanelIntentDeps): boolean {
  switch (intent.kind) {
    case "doc":
      deps.openRepoFile(intent.target);
      return true;
    case "page":
      deps.openPage(intent.target);
      return true;
    case "kanban":
      deps.openKanban();
      return true;
    case "card": {
      const id = deps.resolveCardId(intent.target);
      // Open the focused card if we can resolve it; otherwise just reveal the
      // board so the agent's intent isn't silently dropped.
      if (!id || !deps.openCard(id)) deps.openKanban();
      return true;
    }
    default:
      return false;
  }
}
