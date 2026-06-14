import { describe, test, expect } from "vitest";
import { EventEmitter } from "node:events";
import type { Host, VaultStore } from "@orden/host-api";
import { handleAgentRequest } from "../src/agentRoute";

// Minimal in-memory vault (mirrors hooks.test.ts / packages/mcp/test/fakeVault).
function fakeVault(seed: Record<string, Record<string, unknown>> = {}): VaultStore {
  const store = new Map<string, Map<string, unknown>>();
  for (const [ns, kv] of Object.entries(seed)) store.set(ns, new Map(Object.entries(kv)));
  const nsMap = (ns: string) => store.get(ns) ?? store.set(ns, new Map()).get(ns)!;
  return {
    async get<T>(ns: string, key: string) {
      return (nsMap(ns).get(key) ?? null) as T | null;
    },
    async set<T>(ns: string, key: string, value: T) {
      nsMap(ns).set(key, value);
    },
    async list(ns: string) {
      return [...nsMap(ns).keys()];
    },
    async delete(ns: string, key: string) {
      nsMap(ns).delete(key);
    },
  };
}

const hostWith = (vault: VaultStore): Host => ({ vault }) as unknown as Host;

// A fake IncomingMessage that delivers an optional JSON body once the handler
// has subscribed (process.nextTick fires after the synchronous on() calls).
function mockReq(method: string, url: string, body?: unknown): EventEmitter & { method: string; url: string } {
  const req = new EventEmitter() as EventEmitter & { method: string; url: string };
  req.method = method;
  req.url = url;
  process.nextTick(() => {
    if (body !== undefined) req.emit("data", Buffer.from(JSON.stringify(body)));
    req.emit("end");
  });
  return req;
}

interface CapturedRes {
  status: number;
  json: () => { ok: boolean; message: string };
  done: Promise<void>;
}
function mockRes(): { res: unknown; cap: CapturedRes } {
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => (resolveDone = r));
  const state = { status: 0, body: "" };
  const res = {
    writeHead(status: number) {
      state.status = status;
      return res;
    },
    end(chunk?: string) {
      if (chunk) state.body = chunk;
      resolveDone();
    },
  };
  return {
    res,
    cap: {
      get status() {
        return state.status;
      },
      json: () => JSON.parse(state.body) as { ok: boolean; message: string },
      done,
    } as CapturedRes,
  };
}

async function call(host: Host, method: string, url: string, body?: unknown): Promise<CapturedRes> {
  const { res, cap } = mockRes();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await handleAgentRequest(host, mockReq(method, url, body) as any, res as any);
  await cap.done;
  return cap;
}

describe("handleAgentRequest — panel-open fallback", () => {
  test("a worktree session's doc resolves against its session: root", async () => {
    const vault = fakeVault({ sessions: { s1: { id: "s1", workdir: "/wt/s1", projectId: "repo" } } });
    const cap = await call(hostWith(vault), "POST", "/agent/panel-open?orden_session_id=s1", {
      kind: "doc",
      target: "docs/report.html",
    });
    expect(cap.status).toBe(200);
    expect(cap.json().ok).toBe(true);
    const intent = await vault.get<{ kind: string; target: string; projectId?: string }>(
      "ui",
      "panel-intent",
    );
    expect(intent?.kind).toBe("doc");
    expect(intent?.target).toBe("docs/report.html");
    expect(intent?.projectId).toBe("session:s1"); // worktree root, mirroring the MCP path
  });

  test("a non-worktree session's doc resolves against its project id", async () => {
    const vault = fakeVault({ sessions: { s1: { id: "s1", projectId: "repo" } } });
    await call(hostWith(vault), "POST", "/agent/panel-open?orden_session_id=s1", {
      kind: "doc",
      target: "docs/x.md",
    });
    const intent = await vault.get<{ projectId?: string }>("ui", "panel-intent");
    expect(intent?.projectId).toBe("repo");
  });

  test("an absolute doc target routes through the 'host' root, not the session root", async () => {
    const vault = fakeVault({ sessions: { s1: { id: "s1", workdir: "/wt/s1", projectId: "repo" } } });
    await call(hostWith(vault), "POST", "/agent/panel-open?orden_session_id=s1", {
      kind: "doc",
      target: "/home/user/.config/notes.md",
    });
    const intent = await vault.get<{ projectId?: string; target: string }>("ui", "panel-intent");
    expect(intent?.target).toBe("/home/user/.config/notes.md");
    expect(intent?.projectId).toBe("host"); // absolute path opens directly, no project
  });

  test("an unknown kind is rejected 400", async () => {
    const vault = fakeVault();
    const cap = await call(hostWith(vault), "POST", "/agent/panel-open", { kind: "wat", target: "x" });
    expect(cap.status).toBe(400);
    expect(cap.json().ok).toBe(false);
  });
});

describe("handleAgentRequest — card fallback", () => {
  test("card-move resolves THIS session's card from orden_session_id", async () => {
    const vault = fakeVault({
      sessions: { s1: { id: "s1" } },
      cards: { c1: { id: "c1", title: "T", state: "planning", sessionIds: ["s1"] } },
    });
    const cap = await call(hostWith(vault), "POST", "/agent/card-move?orden_session_id=s1", {
      state: "in-progress",
    });
    expect(cap.status).toBe(200);
    const card = await vault.get<{ state: string }>("cards", "c1");
    expect(card?.state).toBe("in-progress");
  });

  test("card-move with a bad state is rejected 400", async () => {
    const vault = fakeVault();
    const cap = await call(hostWith(vault), "POST", "/agent/card-move?orden_session_id=s1", {
      state: "complete",
    });
    expect(cap.status).toBe(400);
  });

  test("card-move with no resolvable card is rejected 400", async () => {
    const vault = fakeVault({ sessions: { s1: { id: "s1" } } }); // session exists, no card links it
    const cap = await call(hostWith(vault), "POST", "/agent/card-move?orden_session_id=s1", {
      state: "blocked",
    });
    expect(cap.status).toBe(400);
  });

  test("card-create defaults the project to the calling session's", async () => {
    const vault = fakeVault({
      sessions: { s1: { id: "s1", projectId: "repo" } },
      projects: { repo: { id: "repo", name: "Repo" } },
    });
    const cap = await call(hostWith(vault), "POST", "/agent/card-create?orden_session_id=s1", {
      title: "New idea",
    });
    expect(cap.status).toBe(200);
    expect(cap.json().ok).toBe(true);
    const ids = await vault.list("cards");
    expect(ids).toHaveLength(1);
    const card = await vault.get<{ title: string; state: string; projectId: string }>("cards", ids[0]);
    expect(card?.title).toBe("New idea");
    expect(card?.state).toBe("planning");
    expect(card?.projectId).toBe("repo");
  });

  test("card-create without a title is rejected 400", async () => {
    const vault = fakeVault();
    const cap = await call(hostWith(vault), "POST", "/agent/card-create", {});
    expect(cap.status).toBe(400);
  });
});

describe("handleAgentRequest — method + routing guards", () => {
  test("a non-POST method is rejected 405", async () => {
    const vault = fakeVault();
    const cap = await call(hostWith(vault), "GET", "/agent/panel-open");
    expect(cap.status).toBe(405);
  });

  test("an unknown action is rejected 404", async () => {
    const vault = fakeVault();
    const cap = await call(hostWith(vault), "POST", "/agent/frobnicate", {});
    expect(cap.status).toBe(404);
  });
});
