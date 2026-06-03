// BrowserHost: a browser/localStorage implementation of the Host interface.
// The limited, single-user, browser-only backend (no real sessions/remote);
// it wraps the app's existing project/file stores. See Phase H0.2 of
// docs/plans/2026-05-29-orden-host-backend.md.

import type {
  Host,
  VaultStore,
  ProjectRegistry,
  FileSource,
  SessionManager,
  LockService,
  Identity,
  HostCapabilities,
  Project,
  ProjectSource,
  FileEntry,
  Session,
  SessionState,
  AnnotationSendInput,
  AnnotationSendResult,
  ChatBackend,
  ChatSession,
  ChatMessage,
  ModelOption,
  SlashCommand,
} from "@orden/host-api";

import { listProjects, addProject, removeProject } from "../projects";
import { listFiles, getFile } from "../files";

const VAULT_PREFIX = "orden:vault:";

function vaultKey(ns: string, key: string): string {
  return `${VAULT_PREFIX}${ns}:${key}`;
}

function deriveName(source: ProjectSource): string {
  if (source.kind === "local") {
    const base = source.path.replace(/\/+$/, "").split("/").pop();
    return base && base.length > 0 ? base : "Untitled";
  }
  return "Untitled";
}

class LocalVault implements VaultStore {
  async get<T>(ns: string, key: string): Promise<T | null> {
    const raw = localStorage.getItem(vaultKey(ns, key));
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  async set<T>(ns: string, key: string, value: T): Promise<void> {
    localStorage.setItem(vaultKey(ns, key), JSON.stringify(value));
  }

  async list(ns: string): Promise<string[]> {
    const prefix = `${VAULT_PREFIX}${ns}:`;
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const full = localStorage.key(i);
      if (full && full.startsWith(prefix)) {
        keys.push(full.slice(prefix.length));
      }
    }
    return keys;
  }

  async delete(ns: string, key: string): Promise<void> {
    localStorage.removeItem(vaultKey(ns, key));
  }
}

class LocalIdentity implements Identity {
  async me(): Promise<{ id: string; name: string } | null> {
    return { id: "local", name: "You" };
  }

  async presence(_scope: string): Promise<{ id: string; name: string }[]> {
    return [];
  }
}

class LocalProjects implements ProjectRegistry {
  async list(): Promise<Project[]> {
    return listProjects();
  }

  async add(source: ProjectSource, name?: string): Promise<Project> {
    return addProject(name ?? deriveName(source), source);
  }

  async remove(id: string): Promise<void> {
    removeProject(id);
  }
}

class LocalFiles implements FileSource {
  // Per-project file roots are a NodeHost-only capability (a NodeHost has a
  // real filesystem and resolves projectId to a per-project root). The browser
  // has no real filesystem, so projectId is ignored: list/read serve the single
  // implicit set backed by the in-browser file store (../files), and write is
  // unsupported.
  async list(_projectId: string, _glob?: string): Promise<FileEntry[]> {
    return listFiles().map((f) => ({ path: f.path, title: f.title }));
  }

  async read(_projectId: string, path: string): Promise<string> {
    const file = getFile(path);
    if (!file) throw new Error(`BrowserHost: file not found: ${path}`);
    return file.content;
  }

  async write(_projectId: string, _path: string, _content: string): Promise<void> {
    throw new Error("BrowserHost: file write unsupported");
  }

  // No real filesystem in the browser, so no native picker (capabilities()
  // reports pickDirectory absent, so the UI never offers it). Null is the
  // "cancelled / unsupported" contract.
  async pickDirectory(): Promise<string | null> {
    return null;
  }
}

class LocalSessions implements SessionManager {
  async list(): Promise<Session[]> {
    return [];
  }

  async spawn(
    _projectId: string,
    _opts: { title: string; agent: "claude" | "opencode" },
  ): Promise<Session> {
    throw new Error("BrowserHost: sessions require a host");
  }

  async open(_sessionId: string): Promise<{ channel: string }> {
    throw new Error("BrowserHost: sessions require a host");
  }

  async transition(_sessionId: string, _to: SessionState): Promise<void> {
    throw new Error("BrowserHost: sessions require a host");
  }

  async prompt(_sessionId: string, _text: string): Promise<void> {
    throw new Error("BrowserHost: sessions require a host");
  }

  // No real agents in the browser, so there's nothing to stop.
  async kill(_sessionId: string): Promise<void> {
    /* no-op */
  }

  // No agents in the browser — nothing to deliver to.
  async annotationSend(_input: AnnotationSendInput): Promise<AnnotationSendResult> {
    return { ok: false, reason: "no session linked to this plan" };
  }
}

class LocalChat implements ChatBackend {
  // Chat requires a host process (real claude/opencode adapters). The browser
  // backend has none, so reads return empty and live actions throw — mirroring
  // how LocalSessions stubs the agent surface.
  async listSessions(): Promise<ChatSession[]> {
    return [];
  }

  async createSession(): Promise<ChatSession> {
    throw new Error("browser host has no chat backend");
  }

  async getMessages(): Promise<ChatMessage[]> {
    return [];
  }

  async send(): Promise<void> {
    throw new Error("browser host has no chat backend");
  }

  async respondPermission(): Promise<void> {
    throw new Error("browser host has no chat backend");
  }

  async setModel(): Promise<void> {
    throw new Error("browser host has no chat backend");
  }

  async listModels(): Promise<ModelOption[]> {
    return [];
  }

  async listCommands(): Promise<SlashCommand[]> {
    return [];
  }
}

class LocalLocks implements LockService {
  // Single-user, in-memory no-op: nothing ever contends.
  async acquire(_resource: string): Promise<{ ok: true } | { ok: false; heldBy: string }> {
    return { ok: true };
  }

  async release(_resource: string): Promise<void> {
    /* no-op */
  }

  async heartbeat(_resource: string): Promise<void> {
    /* no-op */
  }

  async holders(_resource: string): Promise<string[]> {
    return [];
  }
}

export class BrowserHost implements Host {
  readonly identity: Identity = new LocalIdentity();
  readonly vault: VaultStore = new LocalVault();
  readonly projects: ProjectRegistry = new LocalProjects();
  readonly files: FileSource = new LocalFiles();
  readonly sessions: SessionManager = new LocalSessions();
  readonly locks: LockService = new LocalLocks();
  readonly chat: ChatBackend = new LocalChat();

  capabilities(): HostCapabilities {
    return {
      remoteProjects: false,
      spawnSessions: false,
      persistentVault: true,
    };
  }
}

export const browserHost = new BrowserHost();
