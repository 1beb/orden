// Kanban items: page-like entities belonging to a project (an issue tracker).
// Backed by the host vault (ns "cards", one key per item id), stored separately
// from wiki pages so they never show up in the Pages index. Accessors stay
// synchronous over a cache hydrated at boot; writes write through.
// A card may have zero or more linked AI sessions (sessionIds); it outlives them
// (deleting a session unlinks it but keeps the card).
import type { SessionState } from "@orden/host-api";
import type { Host } from "@orden/host-api";

export interface Item {
  id: string;
  projectId: string;
  title: string;
  state: SessionState;
  notes: string;
  description?: string; // free text sent to the agent with the title on session start
  sessionIds: string[]; // linked AI sessions (0+)
  dueDate?: string; // ISO yyyy-mm-dd, optional
  completedAt?: number; // epoch ms the card last entered "complete"; drives the 1h fall-off

  // Associated planning doc (a docs/plans/*.md repo path), set by the MCP
  // card_set_plan tool. Host-written, read-only in the web. Listed (with the
  // docs the card's sessions surfaced) in the card modal's Documents section.
  planDoc?: string;

  // Integration state stamped at completion by the host's publish step (worktree
  // isolation): how the session branch left the system. Read-only in the web.
  publishState?: string; // PublishResult["state"]
  branch?: string;
  prUrl?: string;
  compareUrl?: string;
  publishError?: string;

  // Merge-coordinator state, written by the host. Read-only in the web EXCEPT
  // integrationBlock.chosen, which the decision chips set to resume integration.
  mergeStatus?: string; // "queued" | "merging" | "merged" | "blocked-intent" | "blocked-unverifiable"
  integrationBlock?: IntegrationBlock;
  integrationNote?: string; // e.g. "Goal superseded by card X"

  /** @deprecated legacy single-session field; migrated into sessionIds at boot. */
  sessionId?: string;
}

/** A host-posed integration decision, surfaced on a blocked card (no diffs). */
export interface IntegrationBlock {
  kind: "intent" | "unverifiable";
  question: string;
  options?: string[]; // one chip per contributing card id (intent only)
  otherCardIds?: string[];
  chosen?: string; // the winning card id; set by a chip click to resume
}

// Map legacy lifecycle states to the current default lane set so cards stored
// under an older schema still land in a real column. Unknown values -> planning.
// The lane set itself is defined in @orden/host-api (via @orden/workflows); this
// map is only for normalizing historical vault strings.
const LEGACY_STATE_MAP: Record<string, SessionState> = {
  backlog: "planning",
  todo: "planning",
  planning: "planning",
  "in-progress": "in-progress",
  blocked: "blocked",
  ready: "complete",
  complete: "complete",
  broken: "blocked",
  "on-hold": "on-hold",
};

function normalizeState(state: unknown): SessionState {
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

// Card fields the HOST stamps and the web only reads — they flow
// host -> vault -> cache via the change feed, never the other way. A web persist
// writes the WHOLE cached record, so without this guard a stale-cache write
// (the cache lags the host by one async roundtrip) would clobber the host's
// values. Mirrors the HOST_OWNED guard in sessions.ts.
const HOST_OWNED_CARD = [
  "publishState",
  "branch",
  "prUrl",
  "compareUrl",
  "publishError",
  "planDoc",
] as const satisfies readonly (keyof Item)[];

// A web persist writes the full cached card. Two values can be fresher on disk
// than in the (one-roundtrip-stale) cache: the host's integration stamps, and
// `sessionIds` — the host links a session the moment session_create / an MCP
// tool runs, before our change-feed catch-up. So re-read the disk record and
// (a) preserve host-owned fields, (b) UNION the linked sessions, never dropping
// a link the host added. Intentional unlinks go through removeItemSession, which
// writes its own targeted removal rather than this union path.
function persist(id: string): void {
  if (!host) return;
  const updated = cache.find((i) => i.id === id);
  if (!updated) return;
  const h = host;
  void (async () => {
    const cur = await h.vault.get<Item>("cards", id);
    const merged: Item = { ...updated };
    if (cur) {
      merged.sessionIds = [...new Set([...cardSessionIds(updated), ...cardSessionIds(cur)])];
      const m = merged as unknown as Record<string, unknown>;
      const c = cur as unknown as Record<string, unknown>;
      for (const f of HOST_OWNED_CARD) {
        if (c[f] !== undefined) m[f] = c[f];
      }
    }
    await h.vault.set("cards", id, merged);
  })();
}

export function setItemState(id: string, state: SessionState): void {
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

/**
 * Unlink an AI session from a card (the card itself is kept). This is the one
 * intentional `sessionIds` removal, so it writes a TARGETED disk update that
 * drops exactly this id — it must NOT route through the union `persist`, which
 * would merge the link straight back from the disk record.
 */
export function removeItemSession(id: string, sessionId: string): void {
  cache = cache.map((i) =>
    i.id === id ? { ...i, sessionIds: cardSessionIds(i).filter((s) => s !== sessionId) } : i,
  );
  if (!host) return;
  const h = host;
  void (async () => {
    const cur = await h.vault.get<Item>("cards", id);
    if (!cur) return;
    await h.vault.set("cards", id, {
      ...cur,
      sessionIds: cardSessionIds(cur).filter((s) => s !== sessionId),
    });
  })();
}

/**
 * Record the user's answer to an integration decision: set the chosen winning
 * card id on the blocked card. The write-through fires the host's resume reactor
 * (a blocked card whose integrationBlock gains `chosen`), which drops the losing
 * branches and re-drains. The spread preserves every host-written field.
 */
export function chooseIntegrationWinner(id: string, chosen: string): void {
  cache = cache.map((i) => {
    if (i.id !== id || !i.integrationBlock) return i;
    return { ...i, integrationBlock: { ...i.integrationBlock, chosen } };
  });
  persist(id);
}

export function removeItem(id: string): void {
  cache = cache.filter((i) => i.id !== id);
  if (host) void host.vault.delete("cards", id);
}

/** A document associated with a card, ready to open in the main panel. */
export interface CardDoc {
  path: string; // the doc path (doclinks key / planDoc value)
  projectId: string; // file root to open it under (passed to openRepoFile)
  source: "plan" | "session"; // explicit planDoc vs a doc a session surfaced
  /** Agent-supplied one-line "what this includes"; shown beside the doc. */
  description?: string;
}

// A single doclink record (mirrors @orden/mcp's DocLink). Read on demand from
// the host vault — not part of the boot-hydrated card cache.
export interface DocLinkRec {
  sessionId: string;
  at?: number;
  description?: string;
}

/**
 * The documents associated with a card, for the card modal's Documents list:
 * the explicit `planDoc` (if set), plus every doc the card's sessions surfaced
 * via panel_open (the `doclinks` ns maps a doc path to the session that opened
 * it). Async because doclinks aren't hydrated into the card cache — they're read
 * on demand. De-duplicated by path; planDoc wins over a same-path session link.
 */
export async function cardDocuments(item: Item): Promise<CardDoc[]> {
  if (!host) return [];
  const docs: CardDoc[] = [];
  const seen = new Set<string>();

  if (item.planDoc) {
    docs.push({ path: item.planDoc, projectId: item.projectId, source: "plan" });
    seen.add(item.planDoc);
  }

  const sessionIds = new Set(cardSessionIds(item));
  if (sessionIds.size > 0) {
    const h = host;
    const keys = await h.vault.list("doclinks");
    const links = await Promise.all(
      keys.map(async (path) => ({ path, link: await h.vault.get<DocLinkRec>("doclinks", path) })),
    );
    for (const { path, link } of links) {
      if (!link?.sessionId || !sessionIds.has(link.sessionId) || seen.has(path)) continue;
      seen.add(path);
      // Absolute paths open through the host root (openRepoFile self-corrects);
      // a relative path lives under the surfacing session's worktree root.
      const projectId = path.startsWith("/") ? "host" : `session:${link.sessionId}`;
      docs.push({ path, projectId, source: "session", ...(link.description ? { description: link.description } : {}) });
    }
  }

  return docs;
}
