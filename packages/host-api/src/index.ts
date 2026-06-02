export * from "@orden/chat-core";

import type { ChatBackend } from "@orden/chat-core";

export interface HostCapabilities {
  remoteProjects: boolean;
  spawnSessions: boolean;
  persistentVault: boolean;
  /**
   * Absolute path the host's single FileSource is rooted at, if any. The web
   * uses it to scope repo files to the one project whose path matches this root
   * (see isHostFilesRoot), instead of showing them under every project, and to
   * root chat/agent sessions in the repo. Absent when the host exposes no files
   * (e.g. the in-browser host).
   */
  filesRoot?: string;
}

export interface Identity {
  me(): Promise<{ id: string; name: string } | null>;
  presence(scope: string): Promise<{ id: string; name: string }[]>;
}

export interface VaultStore {
  get<T>(ns: string, key: string): Promise<T | null>;
  set<T>(ns: string, key: string, value: T): Promise<void>;
  list(ns: string): Promise<string[]>;
  delete(ns: string, key: string): Promise<void>;
}

export type ProjectSource =
  | { kind: "ephemeral" }
  | { kind: "local"; path: string }
  | { kind: "ssh"; host: string; path: string; user?: string }
  | { kind: "s3"; bucket: string; prefix?: string };

export interface Project {
  id: string;
  name: string;
  source: ProjectSource;
}

export interface ProjectRegistry {
  list(): Promise<Project[]>;
  add(source: ProjectSource, name?: string): Promise<Project>;
  remove(id: string): Promise<void>;
}

export interface FileEntry {
  path: string;
  title: string;
}

export interface FileSource {
  list(projectId: string, glob?: string): Promise<FileEntry[]>;
  read(projectId: string, path: string): Promise<string>;
  write(projectId: string, path: string, content: string): Promise<void>;
}

export type SessionState =
  | "planning"
  | "in-progress"
  | "blocked"
  | "complete";

export interface Session {
  id: string;
  projectId: string;
  title: string;
  state: SessionState;
  conversationId?: string;
  cwd: string;
  agent: "claude" | "opencode";
}

export interface SessionManager {
  list(): Promise<Session[]>;
  spawn(
    projectId: string,
    opts: { title: string; agent: "claude" | "opencode" },
  ): Promise<Session>;
  open(sessionId: string): Promise<{ channel: string }>;
  transition(sessionId: string, to: SessionState): Promise<void>;
  /**
   * Send a message to the session's agent (resuming the conversation). The
   * user message and the agent's reply are appended to the session record in
   * the vault (ns "sessions"), so they stream to clients via the change feed.
   */
  prompt(sessionId: string, text: string): Promise<void>;
  /**
   * Permanently stop a session's running agent (kills the underlying tmux/pty).
   * Idempotent: killing an already-dead or unknown session is a no-op. The web
   * store calls this from deleteSession so removing a session also reaps its
   * agent process; the browser host has no real agents and no-ops.
   */
  kill(sessionId: string): Promise<void>;
  /**
   * Deliver one or more plan-doc annotations to the agent working that plan.
   * The host resolves the card whose planDoc matches, picks a target session
   * (a live one, else the most recent), renders the message, and types it into
   * the live TUI pane (queued for the agent's next turn) or relaunches a dead
   * session with the text queued. Returns a not-linked result rather than
   * throwing when no session backs the plan. The browser host has no agents and
   * always reports not-linked.
   */
  annotationSend(input: AnnotationSendInput): Promise<AnnotationSendResult>;
}

export interface AnnotationRef {
  id: string;
  planDoc: string;
  /** The selector's exact text, when the annotation targets a text range. */
  quote?: string;
  note: string;
  /** The block the annotation anchors to, for position/region selectors. */
  blockId?: string;
}

export interface AnnotationSendInput {
  planDoc: string;
  annotations: AnnotationRef[];
}

export type AnnotationSendResult =
  | { ok: false; reason: string }
  | { ok: true; target: string; delivered: "queued" | "relaunched" | "failed"; count: number };

export interface LockService {
  acquire(resource: string): Promise<{ ok: true } | { ok: false; heldBy: string }>;
  release(resource: string): Promise<void>;
  heartbeat(resource: string): Promise<void>;
  holders(resource: string): Promise<string[]>;
}

export interface Host {
  identity: Identity;
  vault: VaultStore;
  projects: ProjectRegistry;
  files: FileSource;
  sessions: SessionManager;
  locks: LockService;
  chat?: ChatBackend;
  capabilities(): HostCapabilities;
}
