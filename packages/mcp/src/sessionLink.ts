import type { VaultStore } from "@orden/host-api";

export interface SessionRec {
  id: string;
  conversationId?: string;
  projectId?: string;
  [k: string]: unknown;
}
export interface CardRec {
  id: string;
  title: string;
  state: string;
  projectId?: string;
  sessionIds?: string[];
  sessionId?: string;
  notes?: string;
  [k: string]: unknown;
}

const links = (c: CardRec): string[] =>
  Array.isArray(c.sessionIds) ? c.sessionIds : c.sessionId ? [c.sessionId] : [];

export async function sessionForConversation(
  vault: VaultStore,
  conversationId: string,
): Promise<SessionRec | null> {
  for (const id of await vault.list("sessions")) {
    const rec = await vault.get<SessionRec>("sessions", id);
    if (rec?.conversationId === conversationId) return rec;
  }
  return null;
}

export async function cardForSession(
  vault: VaultStore,
  ordenSessionId: string,
): Promise<CardRec | null> {
  for (const id of await vault.list("cards")) {
    const card = await vault.get<CardRec>("cards", id);
    if (card && links(card).includes(ordenSessionId)) return card;
  }
  return null;
}

export interface FindResult {
  card: CardRec | null;
  candidates: string[];
}

export async function findCard(vault: VaultStore, target: string): Promise<FindResult> {
  const ids = await vault.list("cards");
  const cards = (await Promise.all(ids.map((id) => vault.get<CardRec>("cards", id)))).filter(
    (c): c is CardRec => !!c,
  );
  const byId = cards.find((c) => c.id === target);
  if (byId) return { card: byId, candidates: [] };
  const t = target.trim().toLowerCase();
  const byTitle = cards.find((c) => c.title.trim().toLowerCase() === t);
  if (byTitle) return { card: byTitle, candidates: [] };
  const candidates = cards
    .filter((c) => c.title.toLowerCase().includes(t))
    .map((c) => c.title)
    .slice(0, 5);
  return { card: null, candidates };
}
