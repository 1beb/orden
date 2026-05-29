// Real AI sessions on the host. The session record lives in the vault (ns
// "sessions", the shape the web's sessions.ts uses); prompt() appends the user
// message, runs the agent (claude now; opencode later), appends the reply, and
// drives the linked kanban card's state. All writes go through the host vault,
// so the change feed streams them live to the UI.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import type { SessionManager, Session, SessionState, VaultStore } from "@orden/host-api";

const exec = promisify(execFile);

interface Msg {
  role: "user" | "agent" | "system";
  text: string;
  at: string;
}
interface SessionRecord {
  id: string;
  title: string;
  agent: "claude" | "opencode";
  projectId: string;
  conversationId?: string;
  messages: Msg[];
}
interface CardRecord {
  id: string;
  state: SessionState;
  title: string;
  sessionId?: string;
  [k: string]: unknown;
}

export interface AgentRunResult {
  reply: string;
  conversationId: string;
  title?: string;
}
export type AgentRunner = (opts: {
  agent: "claude" | "opencode";
  conversationId?: string;
  cwd: string;
  prompt: string;
}) => Promise<AgentRunResult>;

const nowIso = (): string => new Date().toISOString();
const deriveTitle = (text: string): string =>
  text.trim().split(/\s+/).slice(0, 6).join(" ").slice(0, 60) || "Session";

// Real runner: drive Claude Code headlessly. First turn mints a session id; later
// turns resume it. --output-format json gives us the reply + the session id.
const claudeRunner: AgentRunner = async ({ agent, conversationId, cwd, prompt }) => {
  if (agent !== "claude") throw new Error(`agent not supported yet: ${agent}`);
  const id = conversationId ?? randomUUID();
  const base = ["-p", "--output-format", "json", "--dangerously-skip-permissions"];
  const args = conversationId
    ? [...base, "--resume", conversationId, prompt]
    : [...base, "--session-id", id, prompt];
  const { stdout } = await exec("claude", args, { cwd, maxBuffer: 32 * 1024 * 1024 });
  const data = JSON.parse(stdout) as { result?: string; session_id?: string };
  return { reply: data.result ?? "(no output)", conversationId: data.session_id ?? id };
};

export interface NodeSessionsOptions {
  vault: VaultStore;
  defaultCwd: string;
  runner?: AgentRunner;
}

export class NodeSessions implements SessionManager {
  private readonly vault: VaultStore;
  private readonly defaultCwd: string;
  private readonly runner: AgentRunner;

  constructor(opts: NodeSessionsOptions) {
    this.vault = opts.vault;
    this.defaultCwd = opts.defaultCwd;
    this.runner = opts.runner ?? claudeRunner;
  }

  async list(): Promise<Session[]> {
    return []; // the web reads sessions via its own vault-backed store
  }
  async spawn(): Promise<Session> {
    throw new Error("NodeHost: create sessions from the UI (vault ns 'sessions')");
  }
  async open(): Promise<{ channel: string }> {
    throw new Error("NodeHost: sessions.open not implemented");
  }
  async transition(): Promise<void> {
    /* lifecycle lives on the linked card */
  }

  private async updateLinkedCard(
    sessionId: string,
    patch: Partial<CardRecord>,
  ): Promise<void> {
    const ids = await this.vault.list("cards");
    for (const cid of ids) {
      const card = await this.vault.get<CardRecord>("cards", cid);
      if (card && card.sessionId === sessionId) {
        await this.vault.set("cards", cid, { ...card, ...patch });
        return;
      }
    }
  }

  async prompt(sessionId: string, text: string): Promise<void> {
    const rec = await this.vault.get<SessionRecord>("sessions", sessionId);
    if (!rec) throw new Error(`unknown session: ${sessionId}`);

    await this.updateLinkedCard(sessionId, { state: "in-progress" });
    rec.messages.push({ role: "user", text, at: nowIso() });
    await this.vault.set("sessions", sessionId, rec);

    let result: AgentRunResult;
    try {
      result = await this.runner({
        agent: rec.agent,
        conversationId: rec.conversationId,
        cwd: this.defaultCwd,
        prompt: text,
      });
    } catch (err) {
      rec.messages.push({
        role: "system",
        text: `agent error: ${err instanceof Error ? err.message : String(err)}`,
        at: nowIso(),
      });
      await this.vault.set("sessions", sessionId, rec);
      await this.updateLinkedCard(sessionId, { state: "broken" });
      return;
    }

    rec.conversationId = result.conversationId;
    rec.messages.push({ role: "agent", text: result.reply, at: nowIso() });
    if (!rec.title || rec.title === "Untitled") {
      rec.title = result.title?.trim() || deriveTitle(text);
    }
    await this.vault.set("sessions", sessionId, rec);
    await this.updateLinkedCard(sessionId, { state: "ready", title: rec.title });
  }
}
