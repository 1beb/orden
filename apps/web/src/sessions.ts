// AI sessions: a conversation with claude or opencode, stored in the host vault
// (ns "sessions"). Separate-but-linked to the kanban — creating a session also
// drops a linked card into planning (cards.ts), so the board is populated with
// active sessions. Accessors are synchronous over a cache hydrated at boot;
// writes write through. The live agent backend (spawn/resume) runs the embedded
// agent TUI per session.
import type { Host } from "@orden/host-api";
import {
  addItem,
  listItems,
  setItemState,
  addItemSession,
  removeItemSession,
  cardSessionIds,
  type Item,
} from "./cards";
import { ensureDefaultProject } from "./projects";
import { loadSettings } from "./settings";

export type Agent = "claude" | "opencode";

export interface Session {
  id: string;
  title: string;
  agent: Agent;
  projectId: string;
  mode?: "tui" | "gui"; // surface the session opens in; absent = legacy (both tabs)
  conversationId?: string; // agent's resumable id (H3)
  archived?: boolean; // hidden from the active list (moved to Done)
  touched?: boolean; // user interacted (a TUI keystroke)
  prompted?: boolean; // host found a real human turn in the transcript — never reap
  summary?: string; // digest added once complete / aged (see ensureSummary)
  // Text handed to the agent on first launch (the card's title when started from
  // a card). The host consumes + clears it in buildCommand.
  initialPrompt?: string;
  workdir?: string; // host-assigned per-session git worktree the agent runs in
  branch?: string; // the orden/<slug> branch that worktree was created on
}

export const DAY_MS = 24 * 60 * 60 * 1000;

let host: Host | null = null;
let cache: Session[] = [];
let counter = 0;

export async function hydrateSessions(h: Host): Promise<void> {
  host = h;
  const ids = await h.vault.list("sessions");
  const all = await Promise.all(ids.map((id) => h.vault.get<Session>("sessions", id)));
  cache = all.filter((s): s is Session => s !== null);
}

export function listSessions(includeArchived = false): Session[] {
  return includeArchived ? [...cache] : cache.filter((s) => !s.archived);
}

export function getSession(id: string): Session | undefined {
  return cache.find((s) => s.id === id);
}

/** Sessions linked to a given card, in link order. */
export function sessionsForCard(item: Item): Session[] {
  return cardSessionIds(item)
    .map((id) => getSession(id))
    .filter((s): s is Session => s !== undefined);
}

function linkedCardId(sessionId: string): string | undefined {
  return listItems().find((i) => cardSessionIds(i).includes(sessionId))?.id;
}

/**
 * True when the session is linked to a card the agent has actually worked —
 * in-progress (running) or blocked (done-with-turn, waiting on the user). A card
 * only reaches those states via the agent's lifecycle hooks, so its session did
 * real work even if it never self-titled. Such a session must never be reaped as
 * a "dead stub": doing so unlinks the card, and the user's claude-mark click then
 * silently starts a NEW session instead of resuming the one that blocked it.
 */
function isOnWorkedCard(sessionId: string): boolean {
  const id = linkedCardId(sessionId);
  if (!id) return false;
  const state = listItems().find((i) => i.id === id)?.state;
  return state === "in-progress" || state === "blocked";
}

/** A session whose linked card has reached the Complete column — done, not active. */
export function isSessionComplete(session: Session): boolean {
  const id = linkedCardId(session.id);
  if (!id) return false;
  return listItems().find((i) => i.id === id)?.state === "complete";
}

// Session ids embed their creation time as base36 (`sess_<time36>_<n>`); decode
// it to estimate age. Returns null for ids that don't carry a timestamp.
export function sessionCreatedAt(session: Session): number | null {
  const part = session.id.split("_")[1];
  if (!part) return null;
  const ms = parseInt(part, 36);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

/** A brand-new session no one has touched — not worth keeping. */
export function isAbandoned(s: Session): boolean {
  return (
    !s.touched &&
    (s.title === "Untitled" || s.title === "Untitled session")
  );
}

/**
 * Mark a session as used (a keystroke in its terminal) so it survives reaping.
 * The host also sets `touched` on first keystroke, but that only reaches us via
 * an async vault-change roundtrip — and the reap decision (isAbandoned) reads
 * this cache synchronously. Setting it here closes the race: type, then navigate
 * away fast, and the session is still protected. No-op once already touched.
 */
export function markSessionTouched(id: string): void {
  const session = cache.find((s) => s.id === id);
  if (!session || session.touched) return;
  session.touched = true;
  persist(session);
}

const UNTITLED_TITLES = new Set(["", "Untitled", "Untitled session"]);

/**
 * A session that never earned a title — neither the agent (which titles any real
 * session off its transcript within seconds) nor the user named it. Unlike
 * isAbandoned this ignores `touched`: a session the user typed a keystroke into
 * but that still has no title is a dead stub, not work worth keeping.
 */
export function isUntitled(s: Session): boolean {
  return UNTITLED_TITLES.has((s.title ?? "").trim());
}

/**
 * Reap dead "Untitled" sessions left over from prior runs. The in-panel
 * cleanup() only drops UNTOUCHED ghosts on navigate-away, so a session the user
 * briefly touched but that never got a title (agent crashed / closed before its
 * first turn) lingers forever in the list as a dead "active" session. Call once
 * at boot (after hydrateSessions): nothing is open yet, and a live session gets
 * titled within seconds, so any still-Untitled record on disk is stale. Returns
 * the reaped ids.
 */
export function reapDeadSessions(): string[] {
  // `prompted` is set by the host once it finds a real human turn in the
  // transcript (terminal.ts reconcile) — that's genuine work, never a dead stub,
  // even while still awaiting the agent's self-authored title. A session parked
  // on a worked card (in-progress / blocked) is likewise real work, so it is
  // spared even if neither title nor `prompted` has caught up yet.
  const dead = cache.filter((s) => isUntitled(s) && !s.prompted && !isOnWorkedCard(s.id));
  for (const s of dead) deleteSession(s.id); // removes the record + unlinks its card
  return dead.map((s) => s.id);
}

/**
 * Give a session a summary once it's "done": its card reached complete, or it's
 * older than a day. The host's title poller may have already written a richer
 * summary off the transcript (no `claude -p`); if not, seed from the session's
 * self-authored title so the card always shows something. No-op once a summary
 * exists (so a user edit is never clobbered). Returns the (possibly updated)
 * session.
 */
export function ensureSummary(session: Session, cardState?: string): Session {
  if (session.summary && session.summary.trim()) return session;
  const created = sessionCreatedAt(session);
  const aged = created !== null && Date.now() - created > DAY_MS;
  if (cardState !== "complete" && !aged) return session;
  const seed = session.title && session.title !== "Untitled session" ? session.title : "";
  if (!seed) return session;
  session.summary = seed;
  persist(session);
  return session;
}

/** Set (or clear) a session's summary — the card modal's editable field. */
export function setSessionSummary(id: string, summary: string): void {
  const session = cache.find((s) => s.id === id);
  if (!session) return;
  session.summary = summary;
  persist(session);
}

/** Archive a session (hide it from the list) — like moving its card to Done. */
export function archiveSession(id: string): void {
  const session = cache.find((s) => s.id === id);
  if (!session) return;
  session.archived = true;
  persist(session);
  const cardId = linkedCardId(id);
  if (cardId) setItemState(cardId, "complete");
}

/**
 * Permanently remove a session and unlink it from its card. The card is KEPT
 * (cards are first-class and can have zero sessions) — use removeItem to delete
 * the card itself.
 */
export function deleteSession(id: string): void {
  cache = cache.filter((s) => s.id !== id);
  if (host) {
    // Reap the running agent too (kills its tmux/pty), then drop the record.
    // Fire-and-forget like the vault write; kill is idempotent on the host.
    void host.sessions.kill(id);
    void host.vault.delete("sessions", id);
  }
  const cardId = linkedCardId(id);
  if (cardId) removeItemSession(cardId, id);
}

// Fields the HOST authors and the web only ever reads: they flow
// host -> vault -> cache (via the async change feed), never the other way. The
// cache is refreshed only on that roundtrip, so right after the host mints a
// `conversationId` (buildCommand, at launch) the cache still lacks it. Writing
// the whole cached record straight back would clobber the host's value — and
// because the hook->card mapping matches on conversationId
// (sessionForConversation), that silently severs the auto-cycle and freezes the
// card at planning. So persist re-reads the freshest record and always takes
// these host-owned fields from it rather than from the (possibly stale) cache.
const HOST_OWNED = ["conversationId", "prompted", "workdir", "branch"] as const;

function persist(session: Session): void {
  if (!host) return;
  const h = host;
  void (async () => {
    const cur = (await h.vault.get<Record<string, unknown>>("sessions", session.id)) ?? {};
    const merged: Record<string, unknown> = { ...session };
    for (const f of HOST_OWNED) {
      if (cur[f] !== undefined) merged[f] = cur[f];
    }
    await h.vault.set("sessions", session.id, merged);
  })();
}

/**
 * Reassign a session to a different project. Mirrors cards.setItemProject so a
 * session and its linked card can be moved together (the UI handlers do the dual
 * update — cards.ts must not import this module, to avoid a cycle).
 */
export function setSessionProject(id: string, projectId: string): void {
  const session = cache.find((s) => s.id === id);
  if (!session) return;
  session.projectId = projectId;
  persist(session);
}

export function createSession(opts: {
  title: string;
  agent: Agent;
  projectId?: string;
  // Link to an EXISTING card instead of creating a new one — used when starting
  // a session from a card.
  linkToCardId?: string;
  // Text handed to the agent on first launch (the card's title). The host
  // consumes + clears it once the TUI is spawned.
  initialPrompt?: string;
}): Session {
  counter += 1;
  // No project chosen → drop it in the default "Homeroom" project.
  const projectId = opts.projectId || ensureDefaultProject().id;
  const prompt = opts.initialPrompt?.trim();
  // The per-tool default surface (TUI terminal vs native GUI chat), stamped at
  // creation so the session's mode is fixed even if the setting later changes.
  const mode = loadSettings().defaultMode[opts.agent];
  const session: Session = {
    id: `sess_${Date.now().toString(36)}_${counter}`,
    title: opts.title.trim() || "Untitled session",
    agent: opts.agent,
    projectId,
    mode,
    ...(prompt ? { initialPrompt: prompt } : {}),
  };
  cache.push(session);
  // Starting a TUI session from the web is always an explicit user action, so
  // tell the host to spawn the agent NOW (the pendingLaunch reactor in serve.ts
  // clears the flag and launches the tmux/pty detached). Don't wait for the
  // Terminal tab's /term socket to attach. A GUI session has no tmux — it
  // launches lazily when its Chat surface mounts — so it must NOT carry
  // pendingLaunch. The flag is written to the vault only, not the cache, so
  // later persists don't re-trigger a launch.
  if (host) {
    if (mode === "gui") {
      void host.vault.set("sessions", session.id, session);
    } else {
      void host.vault.set("sessions", session.id, { ...session, pendingLaunch: true });
    }
  }
  // separate-but-linked: a card on the kanban points back to this session.
  // Started from an existing card → link that one; otherwise drop a new card.
  if (opts.linkToCardId) addItemSession(opts.linkToCardId, session.id);
  else addItem(session.projectId, session.title, { sessionId: session.id });
  return session;
}
