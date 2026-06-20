export * from "@orden/chat-core";

// The lifecycle vocabulary (Lane/Role + LifecycleConfig + DEFAULT_LIFECYCLE) is defined
// in @orden/workflows — host-api CONSUMES it (host-api → workflows, mirroring host-api →
// chat-core) and re-exports it so downstream packages (web, mcp, host) import the
// lifecycle types from host-api and never touch @orden/workflows directly for this.
// See docs/plans/2026-06-19-on-hold-and-lifecycle-config.md.
//
// Imported for local use (SessionState alias, Host.lifecycle signature, isExpiredComplete)
// and re-exported below for the public surface.
import {
  DEFAULT_LIFECYCLE,
  COMPLETE_TTL_MS,
  DEFAULT_LANES,
  type Role,
  type DefaultLane,
  type LaneDef,
  type LifecycleConfig,
} from "@orden/workflows";
export {
  DEFAULT_LIFECYCLE,
  COMPLETE_TTL_MS,
  DEFAULT_LANES,
  type Role,
  type DefaultLane,
  type LaneDef,
  type LifecycleConfig,
} from "@orden/workflows";

// Re-export the DOM-free outliner helpers downstream packages need (e.g. @orden/mcp),
// so they depend on the host-api spine rather than reaching back into the generic
// @orden/outliner package directly. Imported via the ./page and ./markdown subpaths
// (not the barrel) to stay DOM-free — the barrel re-exports DOM-typed kanbanView,
// which non-DOM consumers like apps/host can't compile.
export { journalKey } from "@orden/outliner/page";
export { fromMarkdown, toMarkdown } from "@orden/outliner/markdown";

import type { ChatBackend, QuestionResponse } from "@orden/chat-core";

export interface HostCapabilities {
  remoteProjects: boolean;
  spawnSessions: boolean;
  persistentVault: boolean;
  /** True when host.search is available (indexed page/journal search + backlinks). */
  search?: boolean;
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

/** The two vault stores whose markdown content is full-text searchable. */
export type SearchEntryNs = "pages" | "journal";

export interface SearchHit {
  ns: SearchEntryNs;
  name: string;
  /** A short excerpt around the match, with the matched terms bracketed. */
  snippet: string;
  /** Relevance — lower is a better match (bm25). */
  score: number;
}

export interface BacklinkHit {
  /** The source entry (page name or journal date) that links to the target. */
  pageName: string;
  blockId: string;
  /** The linking block's text, for previewing the reference. */
  text: string;
}

/**
 * Host-side, indexed search & backlinks over the vault's page/journal content,
 * so the web no longer hydrates every body to search or resolve backlinks. The
 * backing store (SQLite today) is an implementation detail; this interface is the
 * stable seam. `target` matching is case-insensitive (mirrors page-name lookup).
 */
export interface SearchService {
  query(text: string, opts?: { kinds?: SearchEntryNs[]; limit?: number }): Promise<SearchHit[]>;
  backlinks(target: string): Promise<BacklinkHit[]>;
  /** target (lowercased) -> number of blocks linking to it, for index badges. */
  backlinkCounts(): Promise<Record<string, number>>;
}

/** Outcome of a page rename — failure carries a user-facing reason. */
export type RenameResult = { ok: true } | { ok: false; reason: string };

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
  /** Per-project worktree isolation override. Absent = inherit the global setting. */
  worktreeIsolation?: boolean;
  /**
   * Per-project integration boundary the merge coordinator applies on a green
   * combined state. "fast" = merge to local main + rebuild (origin push stays a
   * gated manual step); "measured" = push + open a PR, never touch main. Absent
   * = inherit the global default.
   */
  integrationMode?: "fast" | "measured";
  /** Per-project gate command. Absent = the global default verify command. */
  integrationVerify?: string;
  /**
   * Per-project command run after a `fast` merge to main (e.g. rebuild a served
   * bundle). Absent/empty = no post-merge build. Project-specific by nature —
   * orden sets it to rebuild its web dist; most projects need nothing.
   */
  integrationRebuild?: string;
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

/**
 * A session/card's lifecycle lane (where it sits on the board). An alias for the
 * default lane set from @orden/workflows — now including the manual `on-hold`
 * lane. Kept as `SessionState` so existing call sites keep type-checking. The
 * open LifecycleConfig (workflows can add custom lanes) is keyed by string; this
 * concrete union is the type-safe default. See
 * docs/plans/2026-06-19-on-hold-and-lifecycle-config.md.
 */
export type SessionState = DefaultLane;

export interface Session {
  id: string;
  projectId: string;
  title: string;
  state: SessionState;
  conversationId?: string;
  cwd: string;
  agent: "claude" | "opencode";
  /** Surface this session opens in. Absent = legacy (both tabs, terminal default). */
  mode?: "tui" | "gui";
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
 * Result of publishing a session worktree's branch on card completion (push +
 * PR; NEVER a merge — integration belongs to the user's own process).
 * - "no-worktree": the session has no isolated worktree; nothing to publish.
 * - "dirty": uncommitted changes in the worktree; completion should be refused
 *   until the agent commits (or the user explicitly forces).
 * - "no-remote": committed but the repo has no origin; the local branch stays.
 * - "pushed": branch pushed; compareUrl set when the forge is recognized.
 * - "pr-opened": branch pushed and a PR created (prUrl).
 * - "push-failed": the push errored (auth/network); branch stays local.
 * - "clean": tree verified clean, branch reported, NOT pushed — the merge
 *   coordinator owns the ordered push/merge (checkOnly mode).
 */
export interface PublishResult {
  state: "no-worktree" | "dirty" | "no-remote" | "pushed" | "pr-opened" | "push-failed" | "clean";
  branch?: string;
  prUrl?: string;
  compareUrl?: string;
  error?: string;
}

/**
 * A proposed artifact change captured during a session — a README/ADR/AGENTS
 * tweak or a new skill — surfaced for the user to review, edit, and accept or
 * reject. One record per proposed change, persisted in the vault ns
 * `"learnings"` keyed by `id`. Canonical home for the cross-package type; both
 * `@orden/web` and `@orden/mcp` import it from here.
 */
export type LearningType = "readme" | "adr" | "agents" | "skill";
/**
 * Lifecycle of a proposed learning. `pending` = awaiting the user's review;
 * `revising` = the user commented and the agent is re-iterating in place (an
 * in-flight state, not actionable by the user until the agent re-proposes it
 * back to `pending`); `accepted`/`rejected` = terminal user decisions.
 */
export type LearningStatus = "pending" | "revising" | "accepted" | "rejected";
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
   * Host-side search & backlink index over page/journal content. Present on
   * hosts that maintain an index (NodeHost via SQLite; BrowserHost via an
   * in-memory scan). Gated by capabilities().search.
   */
  search?: SearchService;
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
   * Publish a session's worktree branch on completion: verify the tree is
   * clean, push the branch, and open a PR when a forge CLI is available (per
   * the prForge setting). Returns "dirty" instead of pushing when uncommitted
   * work remains, so completion flows can refuse and tell the agent to commit.
   * Absent on hosts without git/agents (browser).
   */
  publish?(sessionId: string, meta: { title: string; summary?: string }): Promise<PublishResult>;
  /**
   * Deliver a learning's comment to the agent that proposed it: resolve the
   * learning's session and type the rendered feedback into its live pane (or
   * relaunch a dead session with it queued). "not-linked" when no session backs
   * the learning. Absent on hosts without agents (browser).
   */
  deliverLearningComment?(learningId: string, text: string): Promise<DeliverCommentResult>;
  /**
   * Rename a knowledge page and rewrite every [[OldName]] reference across all
   * pages AND journal entries to [[NewName]], operating directly over the vault
   * (no resident bodies needed on the client). Refuses to turn a page into a
   * journal date or an internal card:/notes: key, and blocks a case-insensitive
   * collision (a pure re-casing of the page's own name is allowed). The derived
   * search index picks up the writes via the change feed. Present on both hosts.
   */
  renamePage?(oldName: string, newName: string): Promise<RenameResult>;
  /**
   * The resolved lifecycle config for the board: the default lane set, ordering,
   * labels, and board policy (which lanes need action, are furled by default, are
   * non-automatic, and the complete dwell time). First cut returns the global
   * DEFAULT_LIFECYCLE; once the workflow board projection lands this resolves the
   * active workflow's lanes over the default, per session/card. Present on both
   * hosts (the default is pure data; no host capability required).
   */
  lifecycle(): LifecycleConfig;
  capabilities(): HostCapabilities;
}

// Escape a string for literal use inside a RegExp.
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const RENAME_ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const RENAME_INTERNAL_PREFIX = /^(card|notes):/;

/**
 * Rename a knowledge page over a VaultStore: re-key the body + sidecar metadata
 * and rewrite [[OldName]] -> [[NewName]] everywhere (pages + journal),
 * whitespace-tolerant and case-insensitive. The single implementation behind
 * both NodeHost.renamePage and BrowserHost.renamePage, so the rules live in one
 * place. Only changed entries are written back. `oldName` is resolved to its
 * canonical (stored) casing case-insensitively before any checks.
 */
export async function renamePageInVault(
  vault: VaultStore,
  oldName: string,
  newName: string,
): Promise<RenameResult> {
  const trimmed = newName.trim();
  if (trimmed.length === 0) return { ok: false, reason: "Name can't be empty." };

  const pageNames = await vault.list("pages");
  const exact = pageNames.find((k) => k === oldName);
  const oldKey =
    exact ?? pageNames.find((k) => k.toLowerCase() === oldName.toLowerCase()) ?? oldName;

  if (RENAME_ISO_DATE.test(oldKey) || RENAME_INTERNAL_PREFIX.test(oldKey) || !pageNames.includes(oldKey)) {
    return { ok: false, reason: "This page can't be renamed." };
  }
  if (RENAME_ISO_DATE.test(trimmed)) return { ok: false, reason: "A page name can't be a date." };
  if (RENAME_INTERNAL_PREFIX.test(trimmed)) return { ok: false, reason: "That name is reserved." };

  // Exact same key (incl. casing) — nothing to do.
  if (trimmed === oldKey) return { ok: true };

  // Collision: another page already uses this name case-insensitively. A page
  // re-casing its own name (same lowercase) passes through.
  const lower = trimmed.toLowerCase();
  for (const key of pageNames) {
    if (key === oldKey) continue;
    if (key.toLowerCase() === lower) return { ok: false, reason: `A page named "${key}" already exists.` };
  }

  // Re-key the body + metadata. Metadata is carried unchanged (a rename isn't a
  // content edit, so the page keeps its place in the activity-sorted index).
  const body = (await vault.get<string>("pages", oldKey)) ?? "";
  const meta = await vault.get<unknown>("pagemeta", oldKey);
  await vault.set("pages", trimmed, body);
  await vault.delete("pages", oldKey);
  if (meta != null) {
    await vault.set("pagemeta", trimmed, meta);
    await vault.delete("pagemeta", oldKey);
  }

  // Rewrite [[oldKey]] -> [[trimmed]] everywhere, whitespace-tolerant and
  // case-insensitive (so [[ oldname ]] is caught too). The renamed page's own
  // body now lives under `trimmed` and is scanned too, so a self-reference
  // updates as well. Only changed entries are written back.
  const linkRe = new RegExp(`\\[\\[\\s*${escapeRegExp(oldKey)}\\s*\\]\\]`, "gi");
  const replacement = `[[${trimmed}]]`;
  for (const ns of ["pages", "journal"] as const) {
    for (const name of await vault.list(ns)) {
      const md = (await vault.get<string>(ns, name)) ?? "";
      const next = md.replace(linkRe, replacement);
      if (next !== md) await vault.set(ns, name, next);
    }
  }

  return { ok: true };
}

/**
 * True once a complete card has aged past its TTL and should fall off the board.
 * Non-complete lanes never expire (on-hold is intentionally parked and never ages
 * off). A complete card with no `completedAt` (stamped before that field existed)
 * is treated as already past its TTL. `ttlMs` lets callers override the dwell time
 * (a user setting); it defaults to COMPLETE_TTL_MS.
 *
 * Moved here from @orden/outliner: it is orden board POLICY, not a generic
 * outliner primitive. See docs/plans/2026-06-19-on-hold-and-lifecycle-config.md.
 */
export function isExpiredComplete(
  card: { state: string; completedAt?: number },
  nowMs: number,
  ttlMs: number = COMPLETE_TTL_MS,
): boolean {
  if (card.state !== "complete") return false;
  const age =
    typeof card.completedAt === "number" ? nowMs - card.completedAt : Infinity;
  return age >= ttlMs;
}
