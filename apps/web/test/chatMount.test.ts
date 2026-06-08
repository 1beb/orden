import { describe, it, expect, beforeEach } from "vitest";
import type { Host } from "@orden/host-api";
import { createChatMount } from "../src/chatMount";
import { hydrateProjects } from "../src/projects";
import type { Session } from "../src/sessions";

// Minimal in-memory vault sufficient for chatMount + projects hydration.
function makeVault(seed: Record<string, Record<string, unknown>> = {}) {
  const data = new Map<string, Map<string, unknown>>();
  for (const [ns, kv] of Object.entries(seed)) {
    data.set(ns, new Map(Object.entries(kv)));
  }
  const nsMap = (ns: string) => {
    let m = data.get(ns);
    if (!m) data.set(ns, (m = new Map()));
    return m;
  };
  return {
    get: <T>(ns: string, key: string) =>
      Promise.resolve((nsMap(ns).get(key) as T | undefined) ?? null),
    set: (ns: string, key: string, value: unknown) => {
      nsMap(ns).set(key, value);
      return Promise.resolve();
    },
    list: (ns: string) => Promise.resolve([...nsMap(ns).keys()]),
    delete: (ns: string, key: string) => {
      nsMap(ns).delete(key);
      return Promise.resolve();
    },
  };
}

interface FakeHost {
  host: Host;
  mirrorCalls: string[];
  createSessionCalls: { harness: string; cwd: string; title?: string }[];
}

// A host with both a chat backend (agent path) and a terminalChat (mirror path),
// each recording the calls chatMount makes so a test can assert which path ran.
function fakeHost(opts: {
  mirrorResult: boolean;
  vault?: ReturnType<typeof makeVault>;
}): FakeHost {
  const mirrorCalls: string[] = [];
  const createSessionCalls: { harness: string; cwd: string; title?: string }[] = [];
  const vault = opts.vault ?? makeVault();

  const chat = {
    listSessions: () => Promise.resolve([]),
    createSession: (o: { harness: string; cwd: string; title?: string }) => {
      createSessionCalls.push(o);
      return Promise.resolve({ id: "agent-conv-1" });
    },
    getMessages: () => Promise.resolve([]),
    getMessagesKeyed: () => Promise.resolve([]),
    send: () => Promise.resolve(),
    respondPermission: () => Promise.resolve(),
    setModel: () => Promise.resolve(),
    listModels: () => Promise.resolve([]),
    listCommands: () => Promise.resolve([]),
  };
  const terminalChat = {
    mirror: (id: string) => {
      mirrorCalls.push(id);
      return Promise.resolve(opts.mirrorResult);
    },
    send: () => Promise.resolve(),
    answerQuestion: () => Promise.resolve(),
  };

  const host = {
    vault,
    chat,
    terminalChat,
    capabilities: () => ({ filesRoot: "/global/root" }),
  } as unknown as Host;

  return { host, mirrorCalls, createSessionCalls };
}

function session(over: Partial<Session>): Session {
  return {
    id: "sess-1",
    title: "T",
    agent: "claude",
    projectId: "homeroom",
    ...over,
  };
}

// Drain the unawaited async IIFE inside the mount (mirror lookup, createSession,
// hydrate, view mount) by yielding the microtask queue a few times.
async function settle() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe("createChatMount path selection", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("a gui session NEVER mirrors and takes the agent createSession path", async () => {
    const vault = makeVault({
      projects: {
        proj_a: { id: "proj_a", name: "A", source: { kind: "local", path: "/work/a" } },
      },
    });
    const { host, mirrorCalls, createSessionCalls } = fakeHost({
      mirrorResult: true, // even if mirror WOULD succeed, gui must not call it
      vault,
    });
    await hydrateProjects(host);

    const mount = createChatMount(host, () => {});
    const container = document.createElement("div");
    const dispose = mount(container, session({ mode: "gui", projectId: "proj_a" }));
    await settle();

    expect(mirrorCalls).toEqual([]);
    expect(createSessionCalls).toHaveLength(1);
    // GUI runs in its project's cwd, not the global filesRoot.
    expect(createSessionCalls[0].cwd).toBe("/work/a");
    dispose();
  });

  it("a legacy (mode==null) session attempts mirror first", async () => {
    const { host, mirrorCalls, createSessionCalls } = fakeHost({ mirrorResult: true });
    await hydrateProjects(host);

    const mount = createChatMount(host, () => {});
    const container = document.createElement("div");
    const dispose = mount(container, session({ mode: undefined }));
    await settle();

    expect(mirrorCalls).toEqual(["sess-1"]);
    // Mirror succeeded, so the agent path is not taken.
    expect(createSessionCalls).toEqual([]);
    dispose();
  });

  it("gui cwd falls back to filesRoot for an ephemeral project", async () => {
    const vault = makeVault({
      projects: { homeroom: { id: "homeroom", name: "Homeroom", source: { kind: "ephemeral" } } },
    });
    const { host, createSessionCalls } = fakeHost({ mirrorResult: true, vault });
    await hydrateProjects(host);

    const mount = createChatMount(host, () => {});
    const container = document.createElement("div");
    const dispose = mount(container, session({ mode: "gui", projectId: "homeroom" }));
    await settle();

    expect(createSessionCalls[0].cwd).toBe("/global/root");
    dispose();
  });
});
