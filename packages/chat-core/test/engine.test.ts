import { describe, it, expect, vi } from "vitest";
import { createChatBackend } from "../src/engine";
import { AdapterRegistry } from "../src/registry";
import { MemVault } from "./helpers/memVault";
import { makeFakeDriver, makeFakeAdapter } from "./helpers/fakeDriver";
import type { ChatSession, ModelOption, HarnessDriver } from "../src/index";

// Deterministic id generator for tests.
function seqIds(prefix = "id"): () => string {
  let n = 0;
  return () => `${prefix}${++n}`;
}

// Settle pending microtasks/timers so the background pump can drain the queue.
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

function setup(opts?: { ids?: () => string; models?: ModelOption[] }) {
  const vault = new MemVault();
  const registry = new AdapterRegistry();
  const driver = makeFakeDriver({
    commands: [{ name: "/commit", description: "commit" }],
  });
  const adapter = makeFakeAdapter("claude", driver, opts?.models);
  registry.register(adapter);
  const backend = createChatBackend({
    vault,
    registry,
    genId: opts?.ids ?? seqIds(),
  });
  return { vault, registry, driver, adapter, backend };
}

describe("createChatBackend.createSession", () => {
  it("mints an id, writes meta, and appends to the session index", async () => {
    const { backend, vault } = setup({ ids: seqIds("s") });
    const s = await backend.createSession({ harness: "claude", cwd: "/work", title: "Hi" });

    expect(s.id).toBe("s1");
    expect(s.harness).toBe("claude");
    expect(s.cwd).toBe("/work");
    expect(s.title).toBe("Hi");
    expect(typeof s.createdAt).toBe("number");

    const meta = await vault.get<ChatSession>("chat:s1", "meta");
    expect(meta!.id).toBe("s1");

    const ids = await vault.get<string[]>("chat-index", "ids");
    expect(ids).toEqual(["s1"]);
  });

  it("opens the driver with cwd and model", async () => {
    const { backend, driver } = setup();
    await backend.createSession({ harness: "claude", cwd: "/w", model: "opus" });
    expect(driver.openCalls).toEqual([{ cwd: "/w", model: "opus" }]);
  });
});

describe("createChatBackend pump + getMessages", () => {
  it("reduces a scripted turn into ordered messages", async () => {
    const { backend, driver } = setup({ ids: seqIds("s") });
    const s = await backend.createSession({ harness: "claude", cwd: "/w" });

    driver.push({ kind: "text", messageId: "m1", text: "Hello" });
    driver.push({ kind: "tool", messageId: "m1", toolId: "t1", name: "bash", input: { cmd: "ls" } });
    driver.push({ kind: "tool-result", toolId: "t1", output: "file.txt", ok: true });
    driver.push({ kind: "text", messageId: "m1", text: " done" });
    driver.push({ kind: "turn-end" });
    await tick();

    const msgs = await backend.getMessages(s.id);
    expect(msgs).toHaveLength(1);
    const parts = msgs[0].parts;
    expect(parts[0]).toEqual({ type: "text", text: "Hello" });
    expect(parts[1]).toMatchObject({ type: "tool", name: "bash", state: "done", output: "file.txt" });
    expect(parts[2]).toEqual({ type: "text", text: " done" });
  });

  it("sorts messages numerically by suffix beyond lexical order", async () => {
    const { backend, vault } = setup({ ids: seqIds("s") });
    const s = await backend.createSession({ harness: "claude", cwd: "/w" });
    // Hand-seed out-of-lexical-order keys to prove numeric parse, not string sort.
    await vault.set("chat:" + s.id, "msg:9", { id: "a", role: "assistant", parts: [] });
    await vault.set("chat:" + s.id, "msg:10", { id: "b", role: "assistant", parts: [] });
    const msgs = await backend.getMessages(s.id);
    expect(msgs.map((m) => m.id)).toEqual(["a", "b"]);
  });
});

describe("createChatBackend permission round-trip", () => {
  it("writes a perm request, then resolves the driver promise and deletes the key on allow", async () => {
    // Distinct id streams: "s" for session ids, the engine's genId mints perm ids.
    const ids = (() => {
      let n = 0;
      return () => `g${++n}`;
    })();
    const { backend, driver, vault } = setup({ ids });
    const s = await backend.createSession({ harness: "claude", cwd: "/w" });

    let resolved: { allow: boolean } | null = null;
    const p = driver.firePermission({ toolName: "bash", input: { cmd: "rm" }, title: "Run bash?" });
    p.then((d) => {
      resolved = d;
    });
    await tick();

    // The perm key exists while the request is parked.
    const keys = await vault.list("chat:" + s.id);
    const permKey = keys.find((k) => k.startsWith("perm:"));
    expect(permKey).toBeDefined();
    expect(resolved).toBeNull();

    const permId = permKey!.slice("perm:".length);
    await backend.respondPermission(s.id, permId, { decision: "allow" });
    await p;
    expect(resolved).toEqual({ allow: true });

    const after = await vault.list("chat:" + s.id);
    expect(after.some((k) => k.startsWith("perm:"))).toBe(false);
  });

  it("resolves allow:false on deny", async () => {
    const ids = (() => {
      let n = 0;
      return () => `g${++n}`;
    })();
    const { backend, driver, vault } = setup({ ids });
    const s = await backend.createSession({ harness: "claude", cwd: "/w" });
    const p = driver.firePermission({ toolName: "x", input: {}, title: "?" });
    await tick();
    const permId = (await vault.list("chat:" + s.id))
      .find((k) => k.startsWith("perm:"))!
      .slice("perm:".length);
    await backend.respondPermission(s.id, permId, { decision: "deny" });
    expect(await p).toEqual({ allow: false });
  });

  it("no-ops on an unknown permission id", async () => {
    const { backend } = setup({ ids: seqIds("s") });
    const s = await backend.createSession({ harness: "claude", cwd: "/w" });
    await expect(backend.respondPermission(s.id, "nope", { decision: "allow" })).resolves.toBeUndefined();
  });
});

describe("createChatBackend send/setModel reach the driver", () => {
  it("send forwards text", async () => {
    const { backend, driver } = setup({ ids: seqIds("s") });
    const s = await backend.createSession({ harness: "claude", cwd: "/w" });
    await backend.send(s.id, "hi there");
    expect(driver.sent).toEqual(["hi there"]);
  });

  it("send with model sets the model first", async () => {
    const { backend, driver } = setup({ ids: seqIds("s") });
    const s = await backend.createSession({ harness: "claude", cwd: "/w" });
    await backend.send(s.id, "hi", { model: "opus" });
    expect(driver.models).toEqual(["opus"]);
    expect(driver.sent).toEqual(["hi"]);
  });

  it("setModel forwards to the driver", async () => {
    const { backend, driver } = setup({ ids: seqIds("s") });
    const s = await backend.createSession({ harness: "claude", cwd: "/w" });
    await backend.setModel(s.id, "sonnet");
    expect(driver.models).toEqual(["sonnet"]);
  });
});

describe("createChatBackend listModels/listCommands/listSessions", () => {
  it("listModels delegates to the adapter", async () => {
    const models = [{ harness: "claude" as const, id: "opus", label: "Opus" }];
    const { backend } = setup({ ids: seqIds("s"), models });
    expect(await backend.listModels("claude")).toEqual(models);
  });

  it("listCommands delegates to the session driver", async () => {
    const { backend } = setup({ ids: seqIds("s") });
    const s = await backend.createSession({ harness: "claude", cwd: "/w" });
    expect(await backend.listCommands(s.id)).toEqual([
      { name: "/commit", description: "commit" },
    ]);
  });

  it("listSessions returns metas for indexed ids", async () => {
    const { backend } = setup({ ids: seqIds("s") });
    await backend.createSession({ harness: "claude", cwd: "/a", title: "one" });
    await backend.createSession({ harness: "claude", cwd: "/b", title: "two" });
    const sessions = await backend.listSessions();
    expect(sessions.map((s) => s.title)).toEqual(["one", "two"]);
  });
});

describe("createChatBackend resume over a shared vault", () => {
  it("a fresh engine replays getMessages and listSessions without a live driver", async () => {
    const vault = new MemVault();
    const registry = new AdapterRegistry();
    const driver = makeFakeDriver();
    registry.register(makeFakeAdapter("claude", driver));
    const first = createChatBackend({ vault, registry, genId: seqIds("s") });
    const s = await first.createSession({ harness: "claude", cwd: "/w", title: "resumed" });
    driver.push({ kind: "text", messageId: "m1", text: "persisted" });
    driver.push({ kind: "turn-end" });
    await tick();

    // A brand-new engine over the SAME vault, no driver opened for the session.
    const second = createChatBackend({ vault, registry, genId: seqIds("x") });
    const msgs = await second.getMessages(s.id);
    expect(msgs[0].parts[0]).toEqual({ type: "text", text: "persisted" });
    const sessions = await second.listSessions();
    expect(sessions.map((x) => x.title)).toEqual(["resumed"]);
  });

  it("live-driver methods throw on a non-opened session", async () => {
    const { vault, registry } = setup({ ids: seqIds("s") });
    const fresh = createChatBackend({ vault, registry, genId: seqIds("y") });
    await expect(fresh.send("never", "hi")).rejects.toThrow(/not open/);
  });
});

describe("createChatBackend onTurnBoundary", () => {
  function setupWithBoundary() {
    const vault = new MemVault();
    const registry = new AdapterRegistry();
    const driver = makeFakeDriver();
    registry.register(makeFakeAdapter("claude", driver));
    const edges: Array<[string, "start" | "end"]> = [];
    const backend = createChatBackend({
      vault,
      registry,
      genId: seqIds("s"),
      onTurnBoundary: (id, edge) => edges.push([id, edge]),
    });
    return { backend, driver, edges };
  }

  it("fires start on the first event after idle and end on turn-end", async () => {
    const { backend, driver, edges } = setupWithBoundary();
    const s = await backend.createSession({ harness: "claude", cwd: "/w" });

    driver.push({ kind: "text", messageId: "m1", text: "hi" });
    driver.push({ kind: "tool", messageId: "m1", toolId: "t1", name: "bash", input: {} });
    driver.push({ kind: "turn-end" });
    await tick();

    expect(edges).toEqual([
      [s.id, "start"],
      [s.id, "end"],
    ]);
  });

  it("does not fire start for the session handshake event", async () => {
    const { backend, driver, edges } = setupWithBoundary();
    await backend.createSession({ harness: "claude", cwd: "/w" });

    driver.push({ kind: "session", sessionId: "conv1", slashCommands: [] });
    await tick();
    expect(edges).toEqual([]); // a handshake is not real work

    driver.push({ kind: "text", messageId: "m1", text: "go" });
    driver.push({ kind: "turn-end" });
    await tick();
    expect(edges.map((e) => e[1])).toEqual(["start", "end"]);
  });

  it("re-arms: a second turn fires start again", async () => {
    const { backend, driver, edges } = setupWithBoundary();
    await backend.createSession({ harness: "claude", cwd: "/w" });

    driver.push({ kind: "text", messageId: "m1", text: "one" });
    driver.push({ kind: "turn-end" });
    driver.push({ kind: "text", messageId: "m2", text: "two" });
    driver.push({ kind: "turn-end" });
    await tick();

    expect(edges.map((e) => e[1])).toEqual(["start", "end", "start", "end"]);
  });
});

describe("createChatBackend pump errors", () => {
  it("surfaces a pump failure instead of swallowing it", async () => {
    const vault = new MemVault();
    const registry = new AdapterRegistry();
    // A driver whose event stream throws as soon as the pump iterates it.
    const throwing: HarnessDriver = {
      events: {
        // eslint-disable-next-line require-yield
        async *[Symbol.asyncIterator]() {
          throw new Error("boom");
        },
      },
      async send() {},
      async setModel() {},
      async listCommands() {
        return [];
      },
      onPermission() {},
      async close() {},
    };
    registry.register(makeFakeAdapter("claude", throwing));
    const backend = createChatBackend({ vault, registry, genId: seqIds("s") });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await backend.createSession({ harness: "claude", cwd: "/w" });
      await tick();
      expect(errSpy).toHaveBeenCalled();
      expect(errSpy.mock.calls.flat().join(" ")).toContain("s1");
    } finally {
      errSpy.mockRestore();
    }
  });
});
