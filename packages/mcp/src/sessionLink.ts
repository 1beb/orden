import type { VaultStore, SessionState } from "@orden/host-api";

export interface SessionRec {
  id: string;
  conversationId?: string;
  projectId?: string;
  // Set by the MCP session_create tool when auto-launch is on. The host watches
  // for it, spawns a detached agent, and clears the flag. Web-created sessions
  // never set it (they launch on open).
  pendingLaunch?: boolean;
  [k: string]: unknown;
}
export interface CardRec {
  id: string;
  title: string;
  /** Lifecycle lane (where the card sits on the board). See @orden/host-api. */
  state: SessionState;
  projectId?: string;
  sessionIds?: string[];
  sessionId?: string;
  /** Legacy freeform narrative; superseded by the `card:<id>` log page. */
  notes?: string;
  /** Free text sent to the agent with the title when a session starts. */
  description?: string;
  /** Associated planning doc, a docs/plans/*.md repo path. */
  planDoc?: string;
  /** Epoch ms the card last entered "complete"; drives the kanban fade. */
  completedAt?: number;
  /**
   * Summary stashed by `card_complete` for the journal/card-log entry. Read by
   * `logCardCompletion` (called directly and from the host journal reactor) so
   * both completion paths render the same line; absent for a bare web-UI
   * completion, which logs without a summary.
   */
  completionSummary?: string;
  /**
   * Integration state stamped at completion by the publish gate (cardComplete
   * with a Host.publish hook, or the host's publish reactor for web drags):
   * how the session branch left the system. See PublishResult in host-api.
   */
  publishState?: string;
  branch?: string;
  prUrl?: string;
  compareUrl?: string;
  publishError?: string;
  [k: string]: unknown;
}

/** A card's linked session ids, tolerant of the legacy single-sessionId shape. */
export const cardSessionIds = (c: CardRec): string[] =>
  Array.isArray(c.sessionIds) ? c.sessionIds : c.sessionId ? [c.sessionId] : [];

// Internal alias kept so existing call sites read naturally.
const links = cardSessionIds;

export async function sessionForConversation(
  vault: VaultStore,
  conversationId: string,
): Promise<SessionRec | null> {
  for (const id of await vault.list("sessions")) {
    const rec = await vault.get<SessionRec>("sessions", id);
    if (rec?.conversationId === conversationId) return rec;
  }
  // Fallback: the id may be the orden session id itself (the vault key), used
  // when an opencode session connects to the scoped /mcp/<sessionId> endpoint.
  // At that point the opencode-internal conversationId hasn't been discovered
  // yet, but the session record exists and is reachable by its own key.
  return (await vault.get<SessionRec>("sessions", conversationId)) ?? null;
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

export interface PlanDocSessions {
  card: CardRec | null;
  sessionIds: string[];
  /** Near-miss planDoc paths, offered when no card matches exactly. */
  candidates: string[];
}

/**
 * Resolve the card associated with a planning doc (exact `planDoc` match) and
 * its linked session ids. This is a PURE vault read — it makes no liveness
 * decision (the resolver has no tmux visibility); the host picks a target. When
 * no card matches, `candidates` lists other cards' planDoc paths that share the
 * requested path's basename stem, as a cheap "did you mean" hint.
 */
export async function sessionForPlanDoc(
  vault: VaultStore,
  planDocPath: string,
): Promise<PlanDocSessions> {
  const ids = await vault.list("cards");
  const cards = (await Promise.all(ids.map((id) => vault.get<CardRec>("cards", id)))).filter(
    (c): c is CardRec => !!c,
  );
  const match = cards.find((c) => c.planDoc === planDocPath);
  if (match) return { card: match, sessionIds: links(match), candidates: [] };

  // No exact match: surface other plan docs whose filename shares a stem with
  // the requested one (split on non-alphanumerics, ignore the .md extension).
  const stems = (p: string): string[] =>
    (p.split("/").pop() ?? p)
      .replace(/\.md$/, "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
  const want = new Set(stems(planDocPath));
  const candidates = cards
    .map((c) => c.planDoc)
    .filter((p): p is string => typeof p === "string" && p.length > 0)
    .filter((p) => stems(p).some((s) => want.has(s)))
    .slice(0, 5);
  return { card: null, sessionIds: [], candidates };
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
