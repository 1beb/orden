// AI sessions: a conversation with claude or opencode, stored in the host vault
// (ns "sessions"). Separate-but-linked to the kanban — creating a session also
// drops a linked card into backlog (cards.ts), so the board is populated with
// active sessions. Accessors are synchronous over a cache hydrated at boot;
// writes write through. The live agent backend (spawn/resume) lands in H3; for
// now the transcript is whatever's recorded via addMessage.
import type { Host } from "@orden/host-api";
import { addItem } from "./cards";
import { ensureDefaultProject } from "./projects";

export type Agent = "claude" | "opencode";

export interface SessionMessage {
  role: "user" | "agent" | "system";
  text: string;
  at: string;
}

export interface Session {
  id: string;
  title: string;
  agent: Agent;
  projectId: string;
  conversationId?: string; // agent's resumable id (H3)
  messages: SessionMessage[];
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

export function listSessions(): Session[] {
  return [...cache];
}

export function getSession(id: string): Session | undefined {
  return cache.find((s) => s.id === id);
}

function persist(session: Session): void {
  if (host) void host.vault.set("sessions", session.id, session);
}

export function createSession(opts: { title: string; agent: Agent; projectId?: string }): Session {
  counter += 1;
  // No project chosen → drop it in the default "Homeroom" project.
  const projectId = opts.projectId || ensureDefaultProject().id;
  const session: Session = {
    id: `sess_${Date.now().toString(36)}_${counter}`,
    title: opts.title.trim() || "Untitled session",
    agent: opts.agent,
    projectId,
    messages: [],
  };
  cache.push(session);
  persist(session);
  // separate-but-linked: a backlog card on the kanban points back to this session
  addItem(session.projectId, session.title, session.id);
  return session;
}

export function addMessage(id: string, role: SessionMessage["role"], text: string): void {
  const session = cache.find((s) => s.id === id);
  if (!session) return;
  session.messages.push({ role, text, at: new Date().toISOString() });
  persist(session);
}
