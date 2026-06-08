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
   * True when the host can render documents (quarto on PATH). The doc_render
   * MCP tool and the agent render flow are gated on this. Absent/false on the
   * in-browser host and hosts without quarto installed.
   */
  docRender?: boolean;
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
  /**
   * Start watching ONE repo-relative file the client has opened, so an on-disk
   * edit to it (by an agent, git, or an external editor) pushes a `{ns:"files"}`
   * change on the feed and the open doc live-reloads. The host watches only the
   * files clients ask for — there is no project-wide watcher — so callers MUST
   * pair every watch() with an unwatch() when the doc closes or another opens.
   * Idempotent per (projectId, path); refcounted, so repeated opens are safe.
   * Hosts without a filesystem (browser) no-op.
   */
  watch(projectId: string, path: string): Promise<void>;
  /** Release a watch started by watch(). Unknown (projectId, path) is a no-op. */
  unwatch(projectId: string, path: string): Promise<void>;
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

/**
 * The result of rendering a document on the host. `outputPath` is present on
 * success (the rendered artifact); `errors` is a stderr/stdout summary on
 * failure. Both the input path and `outputPath` are PROJECT-RELATIVE across the
 * Host boundary (Host.render translates the absolute artifact path back to a
 * repo-relative one), so the caller can hand `outputPath` straight to panel_open.
 */
export interface RenderResult {
  ok: boolean;
  outputPath?: string;
  errors?: string;
}

/**
 * A proposed artifact change captured during a session — a README/ADR/AGENTS
 * tweak or a new skill — surfaced for the user to review, edit, and accept or
 * reject. One record per proposed change, persisted in the vault ns
 * `"learnings"` keyed by `id`. Canonical home for the cross-package type; both
 * `@orden/web` and `@orden/mcp` import it from here.
 */
export type LearningType = "readme" | "adr" | "agents" | "skill";
export type LearningStatus = "pending" | "accepted" | "rejected";
export interface LearningComment {
  /** Epoch ms. */
  at: number;
  text: string;
}
export interface Learning {
  id: string;
  cardId: string;
  sessionId?: string;
  projectId: string;
  type: LearningType;
  title: string;
  /** Per-learning context shown at the bottom of the review step. */
  recap: string;
  /** Project-relative file to edit/create. */
  targetPath: string;
  op: "edit" | "create";
  /** FULL file content to write on accept (not a patch). */
  proposedContent: string;
  /** Current file content for diff display (edit only). */
  baseContent?: string;
  status: LearningStatus;
  comments?: LearningComment[];
  /** Epoch ms. */
  createdAt: number;
}

/** Result of applying an accepted learning to the project tree. */
export interface ApplyLearningResult {
  written: boolean;
  /** True only when committed to a git repo. False for non-repo dirs AND commit failures — see isRepo to tell them apart. */
  committed: boolean;
  /** True when the target dir is a git work-tree (a commit was attempted). When false, the file was written to disk only — that is normal, not an error. */
  isRepo: boolean;
  /** Project-relative path that was written. */
  path: string;
}

/** Result of delivering a learning's review comment back to the proposing agent. */
export interface DeliverCommentResult {
  /** "queued"/"relaunched" from the delivery primitive, "failed" on a delivery
   *  error, "not-linked" when no session backs the learning to reach. */
  delivered: "queued" | "relaunched" | "failed" | "not-linked";
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
  /**
   * Render a document (e.g. quarto) on the host. `path` is project-relative.
   * Resolves to a RenderResult whose outputPath (on success) is ALSO
   * project-relative. Absent on hosts that cannot render (browser, no quarto) —
   * gated by capabilities().docRender.
   */
  render?(projectId: string, path: string): Promise<RenderResult>;
  /**
   * Apply an accepted learning: write its `proposedContent` to its `targetPath`,
   * and commit it when the target dir is a git work-tree (commit is opportunistic —
   * a non-repo dir is still a successful write). Absent on hosts that can't write
   * files (browser).
   */
  applyLearning?(learningId: string): Promise<ApplyLearningResult>;
  /**
   * Deliver a learning's comment to the agent that proposed it: resolve the
   * learning's session and type the rendered feedback into its live pane (or
   * relaunch a dead session with it queued). "not-linked" when no session backs
   * the learning. Absent on hosts without agents (browser).
   */
  deliverLearningComment?(learningId: string, text: string): Promise<DeliverCommentResult>;
  capabilities(): HostCapabilities;
}
