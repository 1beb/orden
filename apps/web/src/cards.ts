// Kanban items: page-like entities belonging to a project (an issue tracker).
// Backed by the host vault (ns "cards", one key per item id), stored separately
// from wiki pages so they never show up in the Pages index. Accessors stay
// synchronous over a cache hydrated at boot; writes write through.
// A card may have zero or more linked AI sessions (sessionIds); it outlives them
// (deleting a session unlinks it but keeps the card).
import type { CardState } from "@orden/outliner";
import type { Host } from "@orden/host-api";

export interface Item {
  id: string;
  projectId: string;
  title: string;
  state: CardState;
  notes: string;
  description?: string; // free text sent to the agent with the title on session start
  sessionIds: string[]; // linked AI sessions (0+)
  dueDate?: string; // ISO yyyy-mm-dd, optional
  completedAt?: number; // epoch ms the card last entered "complete"; drives the 1h fall-off

  // Integration state stamped at completion by the host's publish step (worktree
  // isolation): how the session branch left the system. Read-only in the web.
  publishState?: string; // PublishResult["state"]
  branch?: string;
  prUrl?: string;
  compareUrl?: string;
  publishError?: string;

  /** @deprecated legacy single-session field; migrated into sessionIds at boot. */
  sessionId?: string;
}

// Map legacy lifecycle states to the current four-state set so cards stored
// under an older schema still land in a real column. Unknown values -> planning.
const LEGACY_STATE_MAP: Record<string, CardState> = {
  backlog: "planning",
  todo: "planning",
  planning: "planning",
  "in-progress": "in-progress",
  blocked: "blocked",
  ready: "complete",
  complete: "complete",
  broken: "blocked",
};

function normalizeState(state: unknown): CardState {
  return LEGACY_STATE_MAP[String(state)] ?? "planning";
}

/** The card's linked sessions, tolerant of the legacy single-sessionId shape. */
export function cardSessionIds(item: Item): string[] {
  if (Array.isArray(item.sessionIds)) return item.sessionIds;
  return item.sessionId ? [item.sessionId] : [];
}

let host: Host | null = null;
let cache: Item[] = [];
let counter = 0;

export async function hydrateCards(h: Host): Promise<void> {
  host = h;
  const ids = await h.vault.list("cards");
  const all = await Promise.all(ids.map((id) => h.vault.get<Item>("cards", id)));
  cache = all.filter((i): i is Item => i !== null);
  // Migrate legacy fields, persisting any change so the normalized value sticks
  // across reloads: lifecycle state -> four-state set, single sessionId -> array.
  for (const item of cache) {
    let changed = false;
    const normalized = normalizeState(item.state);
    if (normalized !== item.state) {
      item.state = normalized;
      changed = true;
    }
    if (!Array.isArray(item.sessionIds)) {
      item.sessionIds = item.sessionId ? [item.sessionId] : [];
      changed = true;
    }
    if (item.sessionId !== undefined) {
      delete item.sessionId;
      changed = true;
    }
    if (changed) void h.vault.set("cards", item.id, item);
  }
}

export function listItems(): Item[] {
  return [...cache];
}

export function getItem(id: string): Item | undefined {
  return cache.find((i) => i.id === id);
}

export function itemsByProject(projectId: string): Item[] {
  return cache.filter((i) => i.projectId === projectId);
}

export interface AddItemOpts {
  sessionId?: string;
  description?: string;
}

export function addItem(projectId: string, title: string, opts: AddItemOpts = {}): Item {
  counter += 1;
  const description = opts.description?.trim();
  const item: Item = {
    id: `item_${Date.now().toString(36)}_${counter}`,
    projectId,
    title: title.trim(),
    state: "planning",
    notes: "",
    sessionIds: opts.sessionId ? [opts.sessionId] : [],
    ...(description ? { description } : {}),
  };
  cache.push(item);
  if (host) void host.vault.set("cards", item.id, item);
  return item;
}

/** Set (or clear, with empty/whitespace) a card's description. */
export function setItemDescription(id: string, description: string): void {
  const trimmed = description.trim();
  cache = cache.map((i) => {
    if (i.id !== id) return i;
    const next: Item = { ...i, description: trimmed };
    if (!trimmed) delete next.description;
    return next;
  });
  persist(id);
}

/** The text handed to an agent starting on this card: title, then description. */
export function promptForItem(item: Item): string {
  return item.description ? `${item.title}\n\n${item.description}` : item.title;
}

function persist(id: string): void {
  const updated = cache.find((i) => i.id === id);
  if (host && updated) void host.vault.set("cards", id, updated);
}

export function setItemState(id: string, state: CardState): void {
  cache = cache.map((i) => {
    if (i.id !== id) return i;
    const next: Item = { ...i, state };
    // Stamp completedAt on the transition INTO complete (preserve it on a
    // re-set so the fade clock isn't reset); clear it when leaving complete.
    if (state === "complete") {
      if (i.state !== "complete") next.completedAt = Date.now();
    } else {
      delete next.completedAt;
    }
    return next;
  });
  persist(id);
}

/** Rename a card. Empty/whitespace titles are ignored (a card keeps its name). */
export function setItemTitle(id: string, title: string): void {
  const trimmed = title.trim();
  if (!trimmed) return;
  cache = cache.map((i) => (i.id === id ? { ...i, title: trimmed } : i));
  persist(id);
}

/** Reassign a card to a different project. */
export function setItemProject(id: string, projectId: string): void {
  cache = cache.map((i) => (i.id === id ? { ...i, projectId } : i));
  persist(id);
}

/** Set (or clear, with undefined) a card's due date — ISO yyyy-mm-dd. */
export function setItemDueDate(id: string, dueDate: string | undefined): void {
  cache = cache.map((i) => (i.id === id ? { ...i, dueDate } : i));
  persist(id);
}

/** Link an AI session to a card (no-op if already linked). */
export function addItemSession(id: string, sessionId: string): void {
  cache = cache.map((i) => {
    if (i.id !== id) return i;
    const existing = cardSessionIds(i);
    if (existing.includes(sessionId)) return { ...i, sessionIds: existing };
    return { ...i, sessionIds: [...existing, sessionId] };
  });
  persist(id);
}

/** Unlink an AI session from a card (the card itself is kept). */
export function removeItemSession(id: string, sessionId: string): void {
  cache = cache.map((i) =>
    i.id === id ? { ...i, sessionIds: cardSessionIds(i).filter((s) => s !== sessionId) } : i,
  );
  persist(id);
}

export function removeItem(id: string): void {
  cache = cache.filter((i) => i.id !== id);
  if (host) void host.vault.delete("cards", id);
}
