import { describe, it, expect } from "vitest";
import type {
  Host,
  HostCapabilities,
  Identity,
  VaultStore,
  ProjectRegistry,
  Project,
  ProjectSource,
  FileSource,
  FileEntry,
  Session,
  SessionManager,
  SessionState,
  LockService,
} from "../src/index";

class NoopHost implements Host {
  identity: Identity = {
    me: async () => null,
    presence: async (_scope: string) => [],
  };

  vault: VaultStore = {
    get: async <T>(_ns: string, _key: string): Promise<T | null> => null,
    set: async <T>(_ns: string, _key: string, _value: T) => {},
    list: async (_ns: string) => [],
    delete: async (_ns: string, _key: string) => {},
  };

  projects: ProjectRegistry = {
    list: async (): Promise<Project[]> => [],
    add: async (source: ProjectSource, name?: string): Promise<Project> => ({
      id: "",
      name: name ?? "",
      source,
    }),
    remove: async (_id: string) => {},
  };

  files: FileSource = {
    list: async (_projectId: string, _glob?: string): Promise<FileEntry[]> => [],
    read: async (_projectId: string, _path: string) => "",
    write: async (_projectId: string, _path: string, _content: string) => {},
  };

  sessions: SessionManager = {
    list: async (): Promise<Session[]> => [],
    spawn: async (
      projectId: string,
      opts: { title: string; agent: "claude" | "opencode" },
    ): Promise<Session> => ({
      id: "",
      projectId,
      title: opts.title,
      state: "planning" satisfies SessionState,
      cwd: "",
      agent: opts.agent,
    }),
    open: async (_sessionId: string) => ({ channel: "" }),
    transition: async (_sessionId: string, _to: SessionState) => {},
    prompt: async (_sessionId: string, _text: string) => {},
    kill: async (_sessionId: string) => {},
    annotationSend: async () => ({ ok: false as const, reason: "no agents" }),
  };

  locks: LockService = {
    acquire: async (_resource: string) => ({ ok: true as const }),
    release: async (_resource: string) => {},
    heartbeat: async (_resource: string) => {},
    holders: async (_resource: string) => [],
  };

  capabilities(): HostCapabilities {
    return {
      remoteProjects: false,
      spawnSessions: false,
      persistentVault: false,
    };
  }
}

describe("Host conformance", () => {
  it("NoopHost implements the Host interface", async () => {
    const host: Host = new NoopHost();

    expect(host.capabilities().persistentVault).toBe(false);
    expect(host.capabilities().remoteProjects).toBe(false);
    expect(host.capabilities().spawnSessions).toBe(false);

    expect(await host.projects.list()).toEqual([]);
    expect(await host.identity.me()).toBeNull();
    expect(await host.sessions.list()).toEqual([]);
    expect(await host.locks.acquire("r")).toEqual({ ok: true });
  });
});
