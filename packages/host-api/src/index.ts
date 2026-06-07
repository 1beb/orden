export * from "@orden/chat-core";

import type { ChatBackend, QuestionResponse } from "@orden/chat-core";

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
  /**
   * Absolute path the host persists its vault into. The web shows it in
   * settings so the user knows where their data lives. Absent for the
   * in-browser host, whose vault is the browser's own storage.
   */
  vaultRoot?: string;
  /**
   * True when the host can pop a native directory chooser (files.pickDirectory).
   * The project modal shows a "Browse…" button only then. Absent/false on the
   * in-browser host and on hosts with no picker tool installed.
   */
  pickDirectory?: boolean;
  /**
   * The host process's IANA time zone (e.g. "America/Toronto"), from its system
   * clock. Journal day-pages are filed by local calendar day, so the web — which
   * may run in a different (or remote) browser zone — defaults to THIS zone
   * rather than the browser's, keeping web edits and host-side auto-logs on the
   * same day. A user can override it via the timeZone setting. Absent on the
   * in-browser host, which falls back to the browser's own zone.
   */
  timeZone?: string;
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
  /** Per-project default agent the launchers pre-select. Absent = ask each time. */
  defaultAgent?: "claude" | "opencode";
  /** Per-project cwd agents launch in. Absent = use the source path / global default. */
  workingDir?: string;
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
  /**
   * Open a native directory chooser on the host and resolve to the selected
   * absolute path, or null when cancelled / unsupported. A browser can't produce
   * a real filesystem path, so the project modal's "Browse…" button routes here.
   * Gated by capabilities().pickDirectory — false hosts hide the button.
   */
  pickDirectory(opts?: { title?: string; startPath?: string }): Promise<string | null>;
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

/**
 * Mirror a live terminal agent session into the chat view, and type into it.
 * Unlike `chat` (which spawns its own agent), this reflects the SAME session the
 * Terminal tab runs: it parses the session's transcript into `chat:<sessionId>`
 * (so the chat store/view render it live) and routes `send` into the agent's
 * tmux pane, so the Chat tab and Terminal tab are two views of one session.
 */
export interface TerminalChat {
  /** Start mirroring the session's transcript into `chat:<sessionId>`. Idempotent.
   *  Returns false if the session can't be mirrored (e.g. unsupported agent). */
  mirror(sessionId: string): Promise<boolean>;
  /** Type `text` into the session's live agent pane (its next-turn input). */
  send(sessionId: string, text: string): Promise<void>;
  /**
   * Answer a pending AskUserQuestion in the session's live pane. `toolId` is the
   * tool_use id of the question (from the mirrored transcript); the host reads
   * the question structure from the transcript and drives claude's interactive
   * menu with the keystrokes the `response` implies. A "chat" response declines
   * all questions so the user can reply in the composer instead.
   */
  answerQuestion(sessionId: string, toolId: string, response: QuestionResponse): Promise<void>;
}

export interface Host {
  identity: Identity;
  vault: VaultStore;
  projects: ProjectRegistry;
  files: FileSource;
  sessions: SessionManager;
  locks: LockService;
  chat?: ChatBackend;
  terminalChat?: TerminalChat;
  capabilities(): HostCapabilities;
}
