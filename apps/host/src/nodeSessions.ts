// SessionManager for the host. Sessions run as the real interactive agent TUI
// (claude/opencode in tmux — see terminal.ts), NOT as headless `claude -p`. The
// session record lives in the vault (ns "sessions", the shape the web's
// sessions.ts uses) and is created/edited by the web UI directly; the TUI bus
// drives the linked kanban card and titles the session from the agent's own
// transcript. This class therefore only satisfies the SessionManager interface;
// the chat-style prompt() path (which used `claude -p`) has been removed.

import type {
  SessionManager,
  Session,
  VaultStore,
  Host,
  AnnotationSendInput,
  AnnotationSendResult,
} from "@orden/host-api";
import { killSessionTmux } from "./terminal";
import { annotationSend, defaultPaneOps } from "./annotationDelivery";

export interface NodeSessionsOptions {
  vault: VaultStore;
  defaultCwd: string;
}

export class NodeSessions implements SessionManager {
  private readonly vault: VaultStore;
  private readonly defaultCwd: string;
  constructor(opts: NodeSessionsOptions) {
    this.vault = opts.vault;
    this.defaultCwd = opts.defaultCwd;
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
  // Chat mode is gone — sessions are the interactive TUI. We never invoke
  // `claude -p`. Kept only to satisfy the interface; surfaces loudly if called.
  async prompt(_sessionId: string, _text: string): Promise<void> {
    throw new Error("NodeHost: chat-mode prompt() removed — sessions run as the interactive TUI");
  }
  // Stop the agent by killing its tmux session (the record is removed by the
  // web store in parallel). Idempotent — killing an unknown session is a no-op.
  async kill(sessionId: string): Promise<void> {
    await killSessionTmux(sessionId);
  }
  // Deliver plan-doc annotations to the agent working that plan. Both the
  // resolver and the tmux/launch ops only touch host.vault, so a vault-only
  // host shape is all the delivery layer needs here.
  async annotationSend(input: AnnotationSendInput): Promise<AnnotationSendResult> {
    const host = { vault: this.vault } as unknown as Host;
    return annotationSend(host, input, defaultPaneOps(host, this.defaultCwd));
  }
}
