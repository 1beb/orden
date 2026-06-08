// NodeHost: the full local Host implementation, backed by the machine's disk
// and (later) processes. This is the reference backend the web app talks to
// over a transport. See Phase H1 of docs/plans/2026-05-29-orden-host-backend.md.
//
// Skeleton scope: the vault is real (DiskVault); projects/files/sessions are
// stubbed until H2/H3. Each stub throws rather than silently no-ops so missing
// wiring surfaces loudly.

import { userInfo } from "node:os";
import type {
  Host,
  Identity,
  VaultStore,
  ProjectRegistry,
  FileSource,
  SessionManager,
  LockService,
  HostCapabilities,
  Project,
  ProjectSource,
  Session,
  SessionState,
  ChatBackend,
  TerminalChat,
  HarnessAdapter,
} from "@orden/host-api";
import { AdapterRegistry, createChatBackend } from "@orden/chat-core";
import { DiskVault } from "./diskVault";
import { FsFiles } from "./fsFiles";
import { makeProjectRootResolver } from "./projectRoots";
import { hasDirectoryPicker } from "./pickDirectory";
import { NodeSessions } from "./nodeSessions";
import { makeClaudeAdapter } from "./chat/adapters/claude";
import { makeOpencodeAdapter } from "./chat/adapters/opencode";
import { NodeTerminalChat } from "./chat/nodeTerminalChat";
import { applyChatTurnBoundary } from "./hooks";

export interface NodeHostOptions {
  /** Directory the vault persists into. */
  vaultRoot: string;
  /** Directory whose markdown files are exposed via `files`. Omit to stub. */
  filesRoot?: string;
  /**
   * Harness adapters the chat backend registers. Injectable so tests can supply
   * a fake adapter instead of spawning a real claude/opencode process. Defaults
   * to the real claude + opencode adapters, which are cheap to construct (they
   * only spawn a process on driver `open()`).
   */
  chatAdapters?: HarnessAdapter[];
}

class NodeIdentity implements Identity {
  async me(): Promise<{ id: string; name: string } | null> {
    const info = userInfo();
    const name = info.username || "you";
    return { id: name, name };
  }

  async presence(_scope: string): Promise<{ id: string; name: string }[]> {
    return [];
  }
}

class StubProjects implements ProjectRegistry {
  async list(): Promise<Project[]> {
    return [];
  }
  async add(_source: ProjectSource, _name?: string): Promise<Project> {
    throw new Error("NodeHost: projects.add not implemented yet (H2)");
  }
  async remove(_id: string): Promise<void> {
    throw new Error("NodeHost: projects.remove not implemented yet (H2)");
  }
}

export interface VaultChange {
  ns: string;
  key: string;
  /** For `files` changes: which project's file changed (set by the watcher). */
  projectId?: string;
}

// Wraps a VaultStore so every write (set/delete) notifies a listener. NodeHost
// uses this to drive the change feed — capturing writes from BOTH buses, since
// the web (ws) and agents (MCP) both go through this one vault.
class EmittingVault implements VaultStore {
  constructor(
    private readonly inner: VaultStore,
    private readonly onWrite: (change: VaultChange) => void,
  ) {}
  get<T>(ns: string, key: string): Promise<T | null> {
    return this.inner.get<T>(ns, key);
  }
  list(ns: string): Promise<string[]> {
    return this.inner.list(ns);
  }
  async set<T>(ns: string, key: string, value: T): Promise<void> {
    await this.inner.set(ns, key, value);
    this.onWrite({ ns, key });
  }
  async delete(ns: string, key: string): Promise<void> {
    await this.inner.delete(ns, key);
    this.onWrite({ ns, key });
  }
}

class NoopLocks implements LockService {
  // Single-process host: no contention yet. Real locking arrives with collab.
  async acquire(_resource: string): Promise<{ ok: true } | { ok: false; heldBy: string }> {
    return { ok: true };
  }
  async release(_resource: string): Promise<void> {}
  async heartbeat(_resource: string): Promise<void> {}
  async holders(_resource: string): Promise<string[]> {
    return [];
  }
}

export class NodeHost implements Host {
  readonly identity: Identity = new NodeIdentity();
  readonly vault: VaultStore;
  readonly projects: ProjectRegistry = new StubProjects();
  readonly files: FileSource;
  readonly sessions: SessionManager;
  readonly locks: LockService = new NoopLocks();
  readonly chat: ChatBackend;
  readonly terminalChat: TerminalChat;

  private readonly changeListeners = new Set<(change: VaultChange) => void>();
  private readonly filesRoot?: string;
  private readonly vaultRoot: string;

  constructor(opts: NodeHostOptions) {
    this.filesRoot = opts.filesRoot;
    this.vaultRoot = opts.vaultRoot;
    this.vault = new EmittingVault(new DiskVault(opts.vaultRoot), (change) => {
      for (const listener of this.changeListeners) listener(change);
    });
    // FsFiles serves every project from its own root (resolved per call from the
    // "projects" vault ns); "repo" aliases filesRoot, and an unresolvable id
    // degrades to empty lists / throwing reads, so this works even with no
    // filesRoot (the former StubFiles case) — no stub needed.
    //
    // The onChange sink turns FsFiles into a live file source: when a doc a
    // client has opened (via files.watch) is edited on disk — by us, an agent,
    // git, anything — FsFiles pushes a projectId-tagged "files" change on the
    // same feed the vault uses, so the open doc live-reloads. Nothing is watched
    // until a client opens a doc, so an idle host holds no fs.watch handles (the
    // old MultiRootWatcher armed recursively over every project root incl.
    // node_modules and exhausted inotify).
    this.files = new FsFiles(makeProjectRootResolver(this, opts.filesRoot), (projectId, path) => {
      for (const listener of this.changeListeners) listener({ ns: "files", key: path, projectId });
    });
    // Sessions run agents on the host; writes go through the emitting vault so
    // transcript + card updates stream live to the UI.
    this.sessions = new NodeSessions({
      vault: this.vault,
      defaultCwd: opts.filesRoot ?? process.cwd(),
    });
    // Native multi-turn chat. Writes go through the emitting vault (ns
    // `chat:<id>`) so transcript + meta stream live to the UI like sessions do.
    // The engine has no teardown: chat drivers live for the host process
    // lifetime; per-session kill is deferred (future work).
    const registry = new AdapterRegistry();
    const adapters = opts.chatAdapters ?? [makeClaudeAdapter(), makeOpencodeAdapter()];
    for (const adapter of adapters) registry.register(adapter);
    // GUI-mode sessions have no tmux pane, so the claude --settings lifecycle
    // hooks that drive kanban card state never fire. Drive the card from the
    // chat engine's turn boundaries instead (Task 13): start => in-progress,
    // end => blocked. applyChatTurnBoundary resolves chat id -> orden session id
    // (via the chat-link map) and honors the never-clobber-complete guard.
    this.chat = createChatBackend({
      vault: this.vault,
      registry,
      onTurnBoundary: (chatSessionId, edge) => {
        void applyChatTurnBoundary(this, chatSessionId, edge).catch((err) => {
          console.error(`chat turn-boundary -> card state failed (${chatSessionId}):`, err);
        });
      },
    });
    // Mirror a terminal session's transcript into the chat view + type into its
    // pane, so the Chat tab is a second view of the SAME session the Terminal
    // tab runs (vs `chat`, which spawns its own agent).
    this.terminalChat = new NodeTerminalChat(this, opts.filesRoot ?? process.cwd());
  }

  /** Subscribe to vault writes (from any bus). Returns an unsubscribe fn. */
  onChange(listener: (change: VaultChange) => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  /** Release any open-doc file watchers. Not needed in production (one host,
   *  process lifetime); used by tests to avoid leaking fs.watch instances. */
  stop(): void {
    if (this.files instanceof FsFiles) this.files.stopWatching();
  }

  capabilities(): HostCapabilities {
    return {
      remoteProjects: false, // H4
      spawnSessions: true, // H3: NodeSessions runs claude/opencode
      persistentVault: true,
      filesRoot: this.filesRoot, // so the web can root chat/agent sessions in the repo
      vaultRoot: this.vaultRoot, // so the web can show where the vault lives
      pickDirectory: hasDirectoryPicker(), // native folder chooser available?
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, // host's local zone; web defaults to it
    };
  }
}
