// Kanban items: page-like entities belonging to a project (an issue tracker).
// Stored separately from wiki pages, so they never show up in the Pages index.
// AI sessions per item arrive with the host backend (sessionId placeholder kept).
import type { CardState } from "@orden/outliner";

export interface Item {
  id: string;
  projectId: string;
  title: string;
  state: CardState;
  notes: string;
  sessionId?: string; // future: associated AI session
}

const KEY = "orden:cards";
let counter = 0;

function load(): Item[] {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function save(items: Item[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(items));
  } catch {
    /* ignore */
  }
}

export function listItems(): Item[] {
  return load();
}

export function itemsByProject(projectId: string): Item[] {
  return load().filter((i) => i.projectId === projectId);
}

export function addItem(projectId: string, title: string): Item {
  const items = load();
  counter += 1;
  const item: Item = {
    id: `item_${Date.now().toString(36)}_${counter}`,
    projectId,
    title: title.trim(),
    state: "backlog",
    notes: "",
  };
  items.push(item);
  save(items);
  return item;
}

export function setItemState(id: string, state: CardState): void {
  save(load().map((i) => (i.id === id ? { ...i, state } : i)));
}
