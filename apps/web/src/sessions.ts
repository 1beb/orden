// AI sessions: a conversation with claude or opencode, stored in the host vault
// (ns "sessions"). Separate-but-linked to the kanban — creating a session also
// drops a linked card into planning (cards.ts), so the board is populated with
// active sessions. Accessors are synchronous over a cache hydrated at boot;
// writes write through. The live agent backend (spawn/resume) runs the embedded
// agent TUI per session.
import type { Host } from "@orden/host-api";
import { addItem, listItems, setItemState, removeItem, setItemSession } from "./cards";
import { ensureDefaultProject } from "./projects";

export type Agent = "claude" | "opencode";

export interface Session {
  id: string;
  title: string;
  agent: Agent;
  projectId: string;
  conversationId?: string; // agent's resumable id (H3)
  archived?: boolean; // hidden from the active list (moved to Done)
  touched?: boolean; // user interacted (a TUI keystroke)
}

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

function linkedCardId(sessionId: string): string | undefined {
  return listItems().find((i) => i.sessionId === sessionId)?.id;
}

/** A brand-new session no one has touched — not worth keeping. */
export function isAbandoned(s: Session): boolean {
  return (
    !s.touched &&
    (s.title === "Untitled" || s.title === "Untitled session")
  );
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

/** Permanently remove a session and its linked card. */
export function deleteSession(id: string): void {
  cache = cache.filter((s) => s.id !== id);
  if (host) void host.vault.delete("sessions", id);
  const cardId = linkedCardId(id);
  if (cardId) removeItem(cardId);
}

function persist(session: Session): void {
  if (host) void host.vault.set("sessions", session.id, session);
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
  // a session from a card that has no AI conversation yet.
  linkToCardId?: string;
}): Session {
  counter += 1;
  // No project chosen → drop it in the default "Homeroom" project.
  const projectId = opts.projectId || ensureDefaultProject().id;
  const session: Session = {
    id: `sess_${Date.now().toString(36)}_${counter}`,
    title: opts.title.trim() || "Untitled session",
    agent: opts.agent,
    projectId,
  };
  cache.push(session);
  persist(session);
  // separate-but-linked: a card on the kanban points back to this session.
  // Started from an existing card → link that one; otherwise drop a new card.
  if (opts.linkToCardId) setItemSession(opts.linkToCardId, session.id);
  else addItem(session.projectId, session.title, session.id);
  return session;
}
