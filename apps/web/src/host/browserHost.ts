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
  KeyedMessage,
  ModelOption,
  SlashCommand,
  SearchService,
  SearchHit,
  BacklinkHit,
  SearchEntryNs,
  RenameResult,
} from "@orden/host-api";
import { renamePageInVault } from "@orden/host-api";
import { fromMarkdown, buildBacklinkIndex } from "@orden/outliner";

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

  // No on-disk files to watch in the browser store; opens never go stale from an
  // external editor, so watching is a no-op.
  async watch(_projectId: string, _path: string): Promise<void> {}

  async unwatch(_projectId: string, _path: string): Promise<void> {}
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

  async getMessagesKeyed(): Promise<KeyedMessage[]> {
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

// A short excerpt around the first match of `q` in `body`, with the match
// bracketed — mirrors the host index's snippet() shape so the UI renders the
// same either way.
function localSnippet(body: string, q: string): string {
  const hay = body.toLowerCase();
  const i = hay.indexOf(q);
  if (i < 0) return body.slice(0, 80);
  const start = Math.max(0, i - 30);
  const end = Math.min(body.length, i + q.length + 30);
  const pre = start > 0 ? "…" : "";
  const post = end < body.length ? "…" : "";
  return `${pre}${body.slice(start, i)}[${body.slice(i, i + q.length)}]${body.slice(i + q.length, end)}${post}`;
}

// Browser fallback for SearchService: scans the localStorage-backed vault on
// demand. No scale concern in single-user browser mode. Reuses @orden/outliner
// for link extraction so backlinks match the host's semantics (case-insensitive,
// one ref per source block per target).
class LocalSearch implements SearchService {
  constructor(private readonly vault: VaultStore) {}

  async query(text: string, opts?: { kinds?: SearchEntryNs[]; limit?: number }): Promise<SearchHit[]> {
    const q = text.trim().toLowerCase();
    if (q === "") return [];
    const kinds: SearchEntryNs[] = opts?.kinds ?? ["pages", "journal"];
    const hits: SearchHit[] = [];
    for (const ns of kinds) {
      for (const name of await this.vault.list(ns)) {
        const body = (await this.vault.get<string>(ns, name)) ?? "";
        const nameHit = name.toLowerCase().includes(q);
        if (!nameHit && !body.toLowerCase().includes(q)) continue;
        hits.push({ ns, name, snippet: localSnippet(body, q), score: nameHit ? 0 : 1 });
      }
    }
    hits.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));
    return hits.slice(0, opts?.limit ?? 50);
  }

  async backlinks(target: string): Promise<BacklinkHit[]> {
    const lower = target.toLowerCase();
    const refs: BacklinkHit[] = [];
    await this.eachEntry((name, body) => {
      const idx = buildBacklinkIndex([{ name, root: fromMarkdown(body) }]);
      const seen = new Set<string>();
      for (const [t, rs] of Object.entries(idx)) {
        if (t.toLowerCase() !== lower) continue;
        for (const r of rs) {
          if (seen.has(r.blockId)) continue;
          seen.add(r.blockId);
          refs.push({ pageName: name, blockId: r.blockId, text: r.text });
        }
      }
    });
    return refs;
  }

  async backlinkCounts(): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    await this.eachEntry((name, body) => {
      const idx = buildBacklinkIndex([{ name, root: fromMarkdown(body) }]);
      const seen = new Set<string>();
      for (const [t, rs] of Object.entries(idx)) {
        const lower = t.toLowerCase();
        for (const r of rs) {
          const k = `${r.blockId} ${lower}`;
          if (seen.has(k)) continue;
          seen.add(k);
          counts[lower] = (counts[lower] ?? 0) + 1;
        }
      }
    });
    return counts;
  }

  private async eachEntry(fn: (name: string, body: string) => void): Promise<void> {
    for (const ns of ["pages", "journal"] as const) {
      for (const name of await this.vault.list(ns)) {
        fn(name, (await this.vault.get<string>(ns, name)) ?? "");
      }
    }
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
  readonly search: SearchService = new LocalSearch(this.vault);

  // Same rename logic as NodeHost (shared helper); LocalSearch rescans on demand
  // so backlinks stay correct without a separate index update.
  renamePage(oldName: string, newName: string): Promise<RenameResult> {
    return renamePageInVault(this.vault, oldName, newName);
  }

  capabilities(): HostCapabilities {
    return {
      remoteProjects: false,
      spawnSessions: false,
      persistentVault: true,
      search: true, // in-memory scan fallback
    };
  }
}

export const browserHost = new BrowserHost();
