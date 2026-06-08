// Learnings: README/ADR/AGENTS.md/skill changes a completing session proposes for
// the user to accept (write the file), reject, or comment on. Backed by the host
// vault (ns "learnings", one key per learning id); the host-side `learning_propose`
// MCP tool persists the records. Accessors stay synchronous over a cache hydrated at
// boot; writes write through. The vault record IS the contract — this file declares
// its own Learning shape rather than importing the host-side type (mirrors cards.ts).
import type { Host } from "@orden/host-api";

const NS = "learnings";

export interface LearningComment {
  at: number;
  text: string;
}

export interface Learning {
  id: string;
  cardId: string;
  sessionId?: string;
  projectId: string;
  type: "readme" | "adr" | "agents" | "skill";
  title: string;
  recap: string;
  targetPath: string;
  op: "edit" | "create";
  proposedContent: string;
  baseContent?: string;
  status: "pending" | "accepted" | "rejected";
  comments?: LearningComment[];
  createdAt: number;
}

let host: Host | null = null;
let cache: Learning[] = [];

export async function hydrateLearnings(h: Host): Promise<void> {
  host = h;
  const ids = await h.vault.list(NS);
  const all = await Promise.all(ids.map((id) => h.vault.get<Learning>(NS, id)));
  cache = all.filter((l): l is Learning => l !== null);
}

export function listLearnings(): Learning[] {
  return [...cache];
}

export function getLearning(id: string): Learning | undefined {
  return cache.find((l) => l.id === id);
}

/** A card's learnings in stable createdAt-ascending order (the stepper's order). */
export function learningsForCard(cardId: string): Learning[] {
  return cache.filter((l) => l.cardId === cardId).sort((a, b) => a.createdAt - b.createdAt);
}

/** How many of a card's learnings are still awaiting a decision. */
export function pendingForCard(cardId: string): number {
  return cache.filter((l) => l.cardId === cardId && l.status === "pending").length;
}

function persist(id: string): void {
  const updated = cache.find((l) => l.id === id);
  if (host && updated) void host.vault.set(NS, id, updated);
}

export function setLearningStatus(id: string, status: Learning["status"]): void {
  cache = cache.map((l) => (l.id === id ? { ...l, status } : l));
  persist(id);
}

export function addLearningComment(id: string, text: string, at: number): void {
  cache = cache.map((l) =>
    l.id === id ? { ...l, comments: [...(l.comments ?? []), { at, text }] } : l,
  );
  persist(id);
}
