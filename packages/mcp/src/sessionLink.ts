import type { VaultStore, SessionState } from "@orden/host-api";

export interface SessionRec {
  id: string;
  conversationId?: string;
  projectId?: string;
  // Absolute path of the session's git worktree (HOST_OWNED). A doc written
  // under this path is owned by this session, so it doubles as a path→session
  // link with no extra bookkeeping (see sessionByWorkdir).
  workdir?: string;
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

// --- doc → session links -------------------------------------------------
//
// An annotation is sent to "the session behind this doc". The card.planDoc match
// (sessionForPlanDoc) only fires when an agent explicitly set planDoc. To make
// review feedback Just Work, we also remember which session opened a doc: the
// `doclinks` ns maps a document path to the session that surfaced it (recorded on
// panel_open and on a web doc-open). Keyed by the SAME path string the Send uses.

export const DOCLINKS_NS = "doclinks";

export interface DocLink {
  sessionId: string;
  /** Epoch ms of the most recent open, for debugging / future LRU. */
  at?: number;
}

export async function recordDocLink(
  vault: VaultStore,
  docPath: string,
  sessionId: string,
  at?: number,
): Promise<void> {
  if (!docPath || !sessionId) return;
  await vault.set(DOCLINKS_NS, docPath, { sessionId, ...(at ? { at } : {}) } satisfies DocLink);
}

export async function docLinkSessionId(
  vault: VaultStore,
  docPath: string,
): Promise<string | null> {
  const link = await vault.get<DocLink>(DOCLINKS_NS, docPath);
  if (!link?.sessionId) return null;
  // Only honor it if the session still exists.
  const rec = await vault.get<SessionRec>("sessions", link.sessionId);
  return rec ? link.sessionId : null;
}

// Find the session whose worktree contains `docPath` (path is at or under the
// session's workdir). The longest matching workdir wins, so a nested worktree
// beats an ancestor. Returns null when no session's worktree owns the path.
export async function sessionByWorkdir(
  vault: VaultStore,
  docPath: string,
): Promise<SessionRec | null> {
  let best: SessionRec | null = null;
  let bestLen = -1;
  for (const id of await vault.list("sessions")) {
    const rec = await vault.get<SessionRec>("sessions", id);
    const wd = rec?.workdir;
    if (!wd) continue;
    const prefix = wd.endsWith("/") ? wd : wd + "/";
    if ((docPath === wd || docPath.startsWith(prefix)) && wd.length > bestLen) {
      best = rec;
      bestLen = wd.length;
    }
  }
  return best;
}

export interface DocSessionResult {
  sessionIds: string[];
  card: CardRec | null;
  /** Which rule resolved it (for logging / tests): plan | link | workdir | none. */
  via: "plan" | "link" | "workdir" | "none";
}

// Resolve the session(s) to deliver a doc's annotations to, trying, in order:
// the explicit planDoc card link, the recorded open-time doc link, then the
// owning worktree. Pure vault reads — creation of a new session when none of
// these match is the host's job (it needs project roots + launch).
export async function sessionsForDoc(
  vault: VaultStore,
  docPath: string,
): Promise<DocSessionResult> {
  const plan = await sessionForPlanDoc(vault, docPath);
  if (plan.card && plan.sessionIds.length > 0) {
    return { sessionIds: plan.sessionIds, card: plan.card, via: "plan" };
  }

  const linkedId = await docLinkSessionId(vault, docPath);
  if (linkedId) {
    return { sessionIds: [linkedId], card: await cardForSession(vault, linkedId), via: "link" };
  }

  const owner = await sessionByWorkdir(vault, docPath);
  if (owner) {
    return { sessionIds: [owner.id], card: await cardForSession(vault, owner.id), via: "workdir" };
  }

  return { sessionIds: [], card: null, via: "none" };
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
