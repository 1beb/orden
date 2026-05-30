// SessionManager for the host. Sessions run as the real interactive agent TUI
// (claude/opencode in tmux — see terminal.ts), NOT as headless `claude -p`. The
// session record lives in the vault (ns "sessions", the shape the web's
// sessions.ts uses) and is created/edited by the web UI directly; the TUI bus
// drives the linked kanban card and titles the session from the agent's own
// transcript. This class therefore only satisfies the SessionManager interface;
// the chat-style prompt() path (which used `claude -p`) has been removed.

import type { SessionManager, Session, VaultStore } from "@orden/host-api";

export interface NodeSessionsOptions {
  vault: VaultStore;
  defaultCwd: string;
}

export class NodeSessions implements SessionManager {
  constructor(_opts: NodeSessionsOptions) {}

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
  // Chat mode is gone — sessions are the interactive TUI. We never invoke
  // `claude -p`. Kept only to satisfy the interface; surfaces loudly if called.
  async prompt(_sessionId: string, _text: string): Promise<void> {
    throw new Error("NodeHost: chat-mode prompt() removed — sessions run as the interactive TUI");
  }
}
