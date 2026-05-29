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
  FileEntry,
  Session,
  SessionState,
} from "@orden/host-api";
import { DiskVault } from "./diskVault";
import { FsFiles } from "./fsFiles";
import { NodeSessions } from "./nodeSessions";

export interface NodeHostOptions {
  /** Directory the vault persists into. */
  vaultRoot: string;
  /** Directory whose markdown files are exposed via `files`. Omit to stub. */
  filesRoot?: string;
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

class StubFiles implements FileSource {
  async list(_projectId: string, _glob?: string): Promise<FileEntry[]> {
    throw new Error("NodeHost: files.list not implemented yet (H2)");
  }
  async read(_projectId: string, _path: string): Promise<string> {
    throw new Error("NodeHost: files.read not implemented yet (H2)");
  }
  async write(_projectId: string, _path: string, _content: string): Promise<void> {
    throw new Error("NodeHost: files.write not implemented yet (H2)");
  }
}

export interface VaultChange {
  ns: string;
  key: string;
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

  private readonly changeListeners = new Set<(change: VaultChange) => void>();

  constructor(opts: NodeHostOptions) {
    this.vault = new EmittingVault(new DiskVault(opts.vaultRoot), (change) => {
      for (const listener of this.changeListeners) listener(change);
    });
    this.files = opts.filesRoot ? new FsFiles(opts.filesRoot) : new StubFiles();
    // Sessions run agents on the host; writes go through the emitting vault so
    // transcript + card updates stream live to the UI.
    this.sessions = new NodeSessions({
      vault: this.vault,
      defaultCwd: opts.filesRoot ?? process.cwd(),
    });
  }

  /** Subscribe to vault writes (from any bus). Returns an unsubscribe fn. */
  onChange(listener: (change: VaultChange) => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  capabilities(): HostCapabilities {
    return {
      remoteProjects: false, // H4
      spawnSessions: true, // H3: NodeSessions runs claude/opencode
      persistentVault: true,
    };
  }
}
