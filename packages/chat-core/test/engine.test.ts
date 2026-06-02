import { describe, it, expect } from "vitest";
import { createChatBackend } from "../src/engine";
import { AdapterRegistry } from "../src/registry";
import { MemVault } from "./helpers/memVault";
import { makeFakeDriver, makeFakeAdapter } from "./helpers/fakeDriver";
import type { ChatSession, ModelOption } from "../src/index";

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
