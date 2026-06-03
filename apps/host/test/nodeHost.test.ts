import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  DriverEvent,
  HarnessAdapter,
  HarnessDriver,
  ModelOption,
  Project,
  SlashCommand,
} from "@orden/host-api";
import { NodeHost } from "../src/nodeHost";
import { dispatch } from "../src/rpc";

let root: string;
let host: NodeHost;
// Track every host so afterEach can stop its file watcher. NodeHost never stops
// the watcher on its own (process-lifetime in prod), so without this each test's
// host leaks an fs.watch/inotify instance — the suite exhausts the per-user limit
// under parallel load and watcher-dependent tests silently stop receiving events.
const hosts: NodeHost[] = [];
const track = (h: NodeHost): NodeHost => {
  hosts.push(h);
  return h;
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "orden-host-"));
  host = track(new NodeHost({ vaultRoot: root }));
});

afterEach(async () => {
  for (const h of hosts.splice(0)) h.stop();
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

describe("NodeHost per-project files", () => {
  // Verifies the real "projects" vault ns end-to-end (not stub): a NodeHost with
  // a filesRoot serves the legacy "repo" id from that root AND serves a local
  // project's own root resolved from a real "projects" record.
  test('files.list resolves "repo" to filesRoot and a local project to its source.path', async () => {
    const filesRoot = await mkdtemp(join(tmpdir(), "orden-repo-"));
    await writeFile(join(filesRoot, "repo.md"), "# Repo");

    const projRoot = await mkdtemp(join(tmpdir(), "orden-proj-"));
    await writeFile(join(projRoot, "doc.md"), "# Doc");

    const fileHost = track(new NodeHost({ vaultRoot: root, filesRoot }));
    const project: Project = {
      id: "p1",
      name: "P",
      source: { kind: "local", path: projRoot },
    };
    await fileHost.vault.set("projects", "p1", project);

    const repoFiles = await fileHost.files.list("repo");
    expect(repoFiles.map((f) => f.path)).toEqual(["repo.md"]);

    const projFiles = await fileHost.files.list("p1");
    expect(projFiles.map((f) => f.path)).toEqual(["doc.md"]);

    await rm(filesRoot, { recursive: true, force: true });
    await rm(projRoot, { recursive: true, force: true });
  });

  test("MultiRootWatcher delivers a projectId-tagged files change on an in-root edit", async () => {
    const filesRoot = await mkdtemp(join(tmpdir(), "orden-repo-"));
    const projRoot = await mkdtemp(join(tmpdir(), "orden-proj-"));

    const fileHost = track(new NodeHost({ vaultRoot: root, filesRoot }));
    await fileHost.vault.set("projects", "p1", {
      id: "p1",
      name: "P",
      source: { kind: "local", path: projRoot },
    } satisfies Project);

    // Give the watcher's refresh() (fired on the projects write) time to arm.
    await new Promise((r) => setTimeout(r, 100));

    const changes: { ns: string; key: string; projectId?: string }[] = [];
    fileHost.onChange((c) => changes.push(c));

    // fs.watch delivery latency varies with machine load, and the watcher may
    // still be arming when we first write. Re-touch the file and poll until the
    // projectId-tagged change arrives (or time out), so a busy parallel suite
    // can't flake this on a fixed wall-clock wait.
    const hit = () =>
      changes.some((c) => c.ns === "files" && c.projectId === "p1" && c.key === "note.md");
    const deadline = Date.now() + 3000;
    while (!hit() && Date.now() < deadline) {
      await writeFile(join(projRoot, "note.md"), `# Note ${Date.now()}`);
      await new Promise((r) => setTimeout(r, 50));
    }

    expect(hit()).toBe(true);

    await rm(filesRoot, { recursive: true, force: true });
    await rm(projRoot, { recursive: true, force: true });
  });
});

describe("NodeHost chat over RPC", () => {
  test("createSession dispatches, streams a chat: change, and getMessages replays the turn", async () => {
    const { adapter, driver } = makeFakeAdapter();
    const chatHost = track(new NodeHost({ vaultRoot: root, chatAdapters: [adapter] }));

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
