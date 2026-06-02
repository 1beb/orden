import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  DriverEvent,
  HarnessAdapter,
  HarnessDriver,
  ModelOption,
  SlashCommand,
} from "@orden/host-api";
import { NodeHost } from "../src/nodeHost";
import { dispatch } from "../src/rpc";

let root: string;
let host: NodeHost;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "orden-host-"));
  host = new NodeHost({ vaultRoot: root });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

// A controllable fake driver: events are pushed via emit()/finish() and drained
// by the engine's pump. Spawns nothing — no real claude/opencode process.
class FakeDriver implements HarnessDriver {
  private queue: DriverEvent[] = [];
  private waiting: ((r: IteratorResult<DriverEvent>) => void) | null = null;
  private ended = false;

  emit(ev: DriverEvent): void {
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: ev, done: false });
    } else {
      this.queue.push(ev);
    }
  }

  get events(): AsyncIterable<DriverEvent> {
    const self = this;
    return {
      [Symbol.asyncIterator](): AsyncIterator<DriverEvent> {
        return {
          next(): Promise<IteratorResult<DriverEvent>> {
            if (self.queue.length > 0) {
              return Promise.resolve({ value: self.queue.shift()!, done: false });
            }
            if (self.ended) return Promise.resolve({ value: undefined as never, done: true });
            return new Promise((resolve) => {
              self.waiting = resolve;
            });
          },
        };
      },
    };
  }

  async send(_text: string): Promise<void> {}
  async setModel(_model: string): Promise<void> {}
  async listCommands(): Promise<SlashCommand[]> {
    return [];
  }
  onPermission(): void {}
  async close(): Promise<void> {
    this.ended = true;
  }
}

// A fake claude adapter whose open() hands back a driver the test controls.
function makeFakeAdapter(): { adapter: HarnessAdapter; driver: () => FakeDriver | null } {
  let opened: FakeDriver | null = null;
  const adapter: HarnessAdapter = {
    harness: "claude",
    async listModels(): Promise<ModelOption[]> {
      return [{ harness: "claude", id: "fake", label: "Fake" }];
    },
    open(): HarnessDriver {
      opened = new FakeDriver();
      return opened;
    },
  };
  return { adapter, driver: () => opened };
}

describe("NodeHost", () => {
  test("vault is disk-backed and round-trips values", async () => {
    await host.vault.set("settings", "theme", { mode: "dark" });
    expect(await host.vault.get("settings", "theme")).toEqual({ mode: "dark" });
  });

  test("reports a persistent vault in capabilities", async () => {
    expect(host.capabilities().persistentVault).toBe(true);
  });

  test("identity reports a local node user", async () => {
    const me = await host.identity.me();
    expect(me).not.toBeNull();
    expect(typeof me!.id).toBe("string");
  });
});

describe("NodeHost chat over RPC", () => {
  test("createSession dispatches, streams a chat: change, and getMessages replays the turn", async () => {
    const { adapter, driver } = makeFakeAdapter();
    const chatHost = new NodeHost({ vaultRoot: root, chatAdapters: [adapter] });

    const changes: { ns: string; key: string }[] = [];
    chatHost.onChange((c) => changes.push(c));

    const created = await dispatch(chatHost, {
      id: 1,
      path: ["chat", "createSession"],
      args: [{ harness: "claude", cwd: "/tmp" }],
    });
    expect(created.ok).toBe(true);
    const session = (created as { ok: true; result: { id: string; harness: string } }).result;
    expect(session.harness).toBe("claude");
    expect(typeof session.id).toBe("string");

    // The engine wrote meta through the emitting vault → a chat: change fired.
    expect(changes.some((c) => c.ns.startsWith("chat:"))).toBe(true);

    // Drive a scripted turn through the fake driver the adapter opened.
    const d = driver();
    expect(d).not.toBeNull();
    d!.emit({ kind: "text", messageId: "m1", text: "hello from agent" });
    d!.emit({ kind: "turn-end" });

    // Let the detached pump drain the events into the vault.
    await new Promise((r) => setTimeout(r, 10));

    const msgsRes = await dispatch(chatHost, {
      id: 2,
      path: ["chat", "getMessages"],
      args: [session.id],
    });
    expect(msgsRes.ok).toBe(true);
    const msgs = (msgsRes as { ok: true; result: { role: string; parts: unknown[] }[] }).result;
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({
      role: "assistant",
      parts: [{ type: "text", text: "hello from agent" }],
    });
  });

  test("listModels dispatches to the real claude adapter's static catalog (spawns nothing)", async () => {
    const res = await dispatch(host, {
      id: 1,
      path: ["chat", "listModels"],
      args: ["claude"],
    });
    expect(res.ok).toBe(true);
    const models = (res as { ok: true; result: ModelOption[] }).result;
    expect(models.length).toBeGreaterThan(0);
    expect(models.every((m) => m.harness === "claude")).toBe(true);
  });
});
