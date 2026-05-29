// Kanban items: page-like entities belonging to a project (an issue tracker).
// Backed by the host vault (ns "cards", one key per item id), stored separately
// from wiki pages so they never show up in the Pages index. Accessors stay
// synchronous over a cache hydrated at boot; writes write through.
// AI sessions per item arrive with the host backend (sessionId placeholder kept).
import type { CardState } from "@orden/outliner";
import type { Host } from "@orden/host-api";

export interface Item {
  id: string;
  projectId: string;
  title: string;
  state: CardState;
  notes: string;
  sessionId?: string; // future: associated AI session
}

let host: Host | null = null;
let cache: Item[] = [];
let counter = 0;

export async function hydrateCards(h: Host): Promise<void> {
  host = h;
  const ids = await h.vault.list("cards");
  const all = await Promise.all(ids.map((id) => h.vault.get<Item>("cards", id)));
  cache = all.filter((i): i is Item => i !== null);
}

export function listItems(): Item[] {
  return [...cache];
}

export function itemsByProject(projectId: string): Item[] {
  return cache.filter((i) => i.projectId === projectId);
}

export function addItem(projectId: string, title: string, sessionId?: string): Item {
  counter += 1;
  const item: Item = {
    id: `item_${Date.now().toString(36)}_${counter}`,
    projectId,
    title: title.trim(),
    state: "backlog",
    notes: "",
    sessionId,
  };
  cache.push(item);
  if (host) void host.vault.set("cards", item.id, item);
  return item;
}

export function setItemState(id: string, state: CardState): void {
  cache = cache.map((i) => (i.id === id ? { ...i, state } : i));
  const updated = cache.find((i) => i.id === id);
  if (host && updated) void host.vault.set("cards", id, updated);
}
