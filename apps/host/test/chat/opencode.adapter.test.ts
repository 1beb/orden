import { describe, it, expect } from "vitest";
import { runAdapterContract } from "@orden/chat-core/testing";
import type { Event, OpencodeClient } from "@opencode-ai/sdk";
import { makeOpencodeAdapter } from "../../src/chat/adapters/opencode";

// A pushable async SSE stream the fake `event.subscribe` returns.
class FakeSse {
  private queue: Event[] = [];
  private waiting: ((r: IteratorResult<Event>) => void) | null = null;
  private ended = false;

  push(ev: Event): void {
    if (this.ended) return;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: ev, done: false });
    } else {
      this.queue.push(ev);
    }
  }

  end(): void {
    this.ended = true;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: undefined as never, done: true });
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<Event, void> {
    try {
      while (true) {
        if (this.queue.length > 0) {
          yield this.queue.shift()!;
          continue;
        }
        if (this.ended) return;
        const next = await new Promise<IteratorResult<Event>>((resolve) => {
          this.waiting = resolve;
        });
        if (next.done) return;
        yield next.value;
      }
    } finally {
      this.ended = true;
    }
  }
}

const SESSION_ID = "ses_1";

// Build a fake OpencodeClient whose SSE stream and permission POST are captured
// so the contract can drive the adapter's REAL translate + SSE loop.
function makeFakeClient() {
  const sse = new FakeSse();
  const permissionPosts: Array<{ id: string; permissionID: string; response: string }> = [];
  let permissionResolve: ((r: string) => void) | null = null;

  const client = {
    session: {
      async create() {
        return { data: { id: SESSION_ID, title: "fake", directory: "/contract" }, error: undefined };
      },
      async prompt() {
        return { data: { info: {}, parts: [] }, error: undefined };
      },
      async command() {
        return { data: { info: {}, parts: [] }, error: undefined };
      },
    },
    command: {
      async list() {
        return { data: [{ name: "init", description: "create AGENTS.md", template: "" }], error: undefined };
      },
    },
    config: {
      async providers() {
        return {
          data: {
            providers: [
              {
                id: "anthropic",
                name: "Anthropic",
                models: {
                  "claude-3-5-sonnet": {
                    id: "claude-3-5-sonnet",
                    providerID: "anthropic",
                    name: "Claude 3.5 Sonnet",
                  },
                },
              },
            ],
            default: {},
          },
          error: undefined,
        };
      },
    },
    event: {
      async subscribe() {
        return { stream: sse };
      },
    },
    async postSessionIdPermissionsPermissionId(opts: {
      path: { id: string; permissionID: string };
      body: { response: string };
    }) {
      permissionPosts.push({
        id: opts.path.id,
        permissionID: opts.path.permissionID,
        response: opts.body.response,
      });
      permissionResolve?.(opts.body.response);
      return { data: true, error: undefined };
    },
  } as unknown as OpencodeClient;

  return {
    client,
    sse,
    permissionPosts,
    // Resolves with the response string the adapter POSTed for the next permission.
    nextPermissionResponse(): Promise<string> {
      return new Promise((resolve) => {
        permissionResolve = resolve;
      });
    },
  };
}

function makeHarness() {
  const fake = makeFakeClient();
  let closed = false;
  const adapter = makeOpencodeAdapter({
    connect: async () => ({
      client: fake.client,
      close: () => {
        closed = true;
        fake.sse.end();
      },
    }),
  });

  return {
    adapter,
    async emitTurn() {
      const text = (t: string): Event =>
        ({
          type: "message.part.updated",
          properties: {
            part: { id: "p1", sessionID: SESSION_ID, messageID: "m1", type: "text", text: t },
          },
        }) as unknown as Event;
      const tool = (state: Record<string, unknown>): Event =>
        ({
          type: "message.part.updated",
          properties: {
            part: {
              id: "p2",
              sessionID: SESSION_ID,
              messageID: "m1",
              type: "tool",
              callID: "c1",
              tool: "bash",
              state,
            },
          },
        }) as unknown as Event;

      fake.sse.push(text("Hi"));
      fake.sse.push(text("Hi there"));
      fake.sse.push(tool({ status: "running", input: { command: "ls" }, time: { start: 1 } }));
      fake.sse.push(
        tool({
          status: "completed",
          input: { command: "ls" },
          output: "ok",
          title: "ls",
          metadata: {},
          time: { start: 1, end: 2 },
        }),
      );
      fake.sse.push({ type: "session.idle", properties: { sessionID: SESSION_ID } } as unknown as Event);
    },
    async emitPermission(): Promise<{ allow: boolean }> {
      const posted = fake.nextPermissionResponse();
      fake.sse.push({
        type: "permission.updated",
        properties: {
          id: "perm_1",
          type: "bash",
          sessionID: SESSION_ID,
          messageID: "m1",
          callID: "c1",
          title: "Run ls",
          metadata: {},
          time: { created: 1 },
        },
      } as unknown as Event);
      const response = await posted;
      return { allow: response !== "reject" };
    },
    expectedModelsMin: 1,
    _isClosed: () => closed,
  };
}

runAdapterContract("opencode", makeHarness);

describe("makeOpencodeAdapter", () => {
  it("flattens providers x models into harness-tagged ModelOptions", async () => {
    const fake = makeFakeClient();
    const adapter = makeOpencodeAdapter({
      connect: async () => ({ client: fake.client, close: () => fake.sse.end() }),
    });
    const models = await adapter.listModels();
    expect(models.length).toBeGreaterThanOrEqual(1);
    expect(models.every((m) => m.harness === "opencode")).toBe(true);
    const m = models[0];
    expect(m.id).toBe("anthropic/claude-3-5-sonnet");
    expect(m.label).toContain("Claude 3.5 Sonnet");
  });

  it("routes a leading-slash send through session.command", async () => {
    const fake = makeFakeClient();
    let commandArgs: unknown = null;
    (fake.client.session as unknown as { command: (o: unknown) => Promise<unknown> }).command = async (
      o: unknown,
    ) => {
      commandArgs = o;
      return { data: { info: {}, parts: [] }, error: undefined };
    };
    const driver = makeOpencodeAdapter({
      connect: async () => ({ client: fake.client, close: () => fake.sse.end() }),
    }).open({ cwd: "/x" });
    await driver.send("/init now");
    await new Promise((r) => setTimeout(r, 0));
    expect(commandArgs).toMatchObject({ body: { command: "init", arguments: "now" } });
    await driver.close();
  });

  it("closes the underlying connection", async () => {
    const h = makeHarness();
    const driver = h.adapter.open({ cwd: "/x" });
    await driver.close();
    await new Promise((r) => setTimeout(r, 0));
    expect(h._isClosed()).toBe(true);
  });

  it("propagates a connect() failure to send() and ends the stream (no hang)", async () => {
    const driver = makeOpencodeAdapter({
      connect: async () => {
        throw new Error("opencode serve failed to start");
      },
    }).open({ cwd: "/x" });

    // The events stream must terminate (pumpEnded) rather than hang forever.
    const drained: unknown[] = [];
    const stream = (async () => {
      for await (const ev of driver.events) drained.push(ev);
    })();

    // send() must reject (await sessionReady/connReady), not deadlock.
    await expect(driver.send("hi")).rejects.toThrow(/serve failed/);
    await stream; // resolves once the generator returns
    expect(drained).toEqual([]);
  });
});
