import { describe, it, expect } from "vitest";
import { runAdapterContract } from "@orden/chat-core/testing";
import type {
  CanUseTool,
  Options,
  Query,
  SDKMessage,
  SDKUserMessage,
  SlashCommand,
} from "@anthropic-ai/claude-agent-sdk";
import { makeClaudeAdapter, type QueryFn } from "../../src/chat/adapters/claude";

// A controllable stand-in for the SDK Query: a pushable async generator plus
// captures of the options the adapter passed (notably canUseTool).
class FakeQuery {
  private queue: SDKMessage[] = [];
  private waiting: ((r: IteratorResult<SDKMessage>) => void) | null = null;
  private ended = false;
  canUseTool: CanUseTool | null = null;
  setModelCalls: (string | undefined)[] = [];
  interrupted = false;
  supportedModelsCalls = 0;

  constructor(options?: Options) {
    this.canUseTool = options?.canUseTool ?? null;
  }

  emit(msg: SDKMessage): void {
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: msg, done: false });
    } else {
      this.queue.push(msg);
    }
  }

  finish(): void {
    this.ended = true;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: undefined as never, done: true });
    }
  }

  async next(): Promise<IteratorResult<SDKMessage, void>> {
    if (this.queue.length > 0) {
      return { value: this.queue.shift()!, done: false };
    }
    if (this.ended) return { value: undefined, done: true };
    return new Promise((resolve) => {
      this.waiting = resolve;
    });
  }

  async return(): Promise<IteratorResult<SDKMessage, void>> {
    this.finish();
    return { value: undefined, done: true };
  }

  [Symbol.asyncIterator](): AsyncGenerator<SDKMessage, void> {
    return this as unknown as AsyncGenerator<SDKMessage, void>;
  }

  async interrupt(): Promise<void> {
    this.interrupted = true;
    this.finish();
  }

  async setModel(model?: string): Promise<void> {
    this.setModelCalls.push(model);
  }

  async supportedCommands(): Promise<SlashCommand[]> {
    return [
      { name: "commit", description: "commit changes", argumentHint: "", aliases: [] },
    ] as unknown as SlashCommand[];
  }

  async supportedModels(): Promise<Array<{ value: string; displayName: string; description: string }>> {
    this.supportedModelsCalls++;
    return [
      { value: "claude-opus-4-8", displayName: "Claude Opus 4.8", description: "Most capable model" },
      { value: "claude-opus-4-8[1m]", displayName: "Claude Opus 4.8 (1M context)", description: "Most capable model with 1M context" },
      { value: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6", description: "Balanced speed and capability" },
      { value: "claude-sonnet-4-6[1m]", displayName: "Claude Sonnet 4.6 (1M context)", description: "Balanced with 1M context" },
      { value: "claude-haiku-4-5", displayName: "Claude Haiku 4.5", description: "Fast and efficient" },
    ];
  }
}

// Build a harness whose fake query is captured so emitTurn/emitPermission can
// drive the very instance the adapter opened.
function makeHarness() {
  let fake: FakeQuery | null = null;
  const fakeQuery: QueryFn = (params) => {
    fake = new FakeQuery(params.options);
    // Drain the input stream in the background so streaming-input send() never
    // wedges; the fake produces output independently via emit().
    void (async () => {
      const prompt = params.prompt;
      if (typeof prompt !== "string") {
        for await (const _ of prompt as AsyncIterable<SDKUserMessage>) {
          // discard; the script drives the conversation
        }
      }
    })();
    return fake as unknown as Query;
  };

  const adapter = makeClaudeAdapter({ query: fakeQuery });

  return {
    adapter,
    async emitTurn() {
      // open() runs synchronously in the contract before emitTurn; fake is set.
      const q = fake!;
      q.emit({
        type: "assistant",
        session_id: "s1",
        message: { id: "m1", content: [{ type: "text", text: "hi" }] },
      } as unknown as SDKMessage);
      q.emit({
        type: "assistant",
        session_id: "s1",
        message: {
          id: "m1",
          content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }],
        },
      } as unknown as SDKMessage);
      q.emit({
        type: "user",
        session_id: "s1",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
        },
      } as unknown as SDKMessage);
      q.emit({
        type: "result",
        subtype: "success",
        session_id: "s1",
        result: "done",
      } as unknown as SDKMessage);
    },
    async emitPermission(): Promise<{ allow: boolean }> {
      const q = fake!;
      const result = await q.canUseTool!(
        "Bash",
        { command: "ls" },
        { title: "Run ls", toolUseID: "t1", signal: new AbortController().signal },
      );
      return { allow: result.behavior === "allow" };
    },
    expectedModelsMin: 3,
  };
}

runAdapterContract("claude", makeHarness);

// A minimal Query stand-in that never emits and accepts the control methods.
function inertQuery(): Query {
  return {
    async *[Symbol.asyncIterator]() {
      /* no messages */
    },
    async interrupt() {},
    async setModel() {},
    async supportedCommands() {
      return [];
    },
  } as unknown as Query;
}

// Direct unit checks beyond the shared contract.
describe("makeClaudeAdapter", () => {
  it("lists claude models dynamically via supportedModels()", async () => {
    // listModels() opens a short-lived query, calls supportedModels(), and tears
    // it down. Our fake query returns a known set that includes [1m] variants.
    let fake: FakeQuery | null = null;
    const fakeQuery: QueryFn = (params) => {
      fake = new FakeQuery(params.options);
      return fake as unknown as Query;
    };
    const adapter = makeClaudeAdapter({ query: fakeQuery });
    const models = await adapter.listModels();
    expect(models.length).toBeGreaterThanOrEqual(3);
    expect(models.every((m) => m.harness === "claude")).toBe(true);
    expect(models.some((m) => m.id.includes("[1m]"))).toBe(true);
    expect(fake!.supportedModelsCalls).toBe(1);
    expect(fake!.interrupted).toBe(true); // cleaned up
  });

  it("returns empty list when supportedModels() fails", async () => {
    const fakeQuery: QueryFn = () => {
      const q = new FakeQuery();
      q.supportedModels = async () => { throw new Error("nope"); };
      return q as unknown as Query;
    };
    const adapter = makeClaudeAdapter({ query: fakeQuery });
    const models = await adapter.listModels();
    expect(models).toEqual([]);
  });

  it("delivers send() payloads to the streaming-input prompt", async () => {
    const delivered: string[] = [];
    const fakeQuery: QueryFn = (params) => {
      const prompt = params.prompt as AsyncIterable<SDKUserMessage>;
      void (async () => {
        for await (const m of prompt) {
          delivered.push(m.message.content as string);
        }
      })();
      return inertQuery();
    };
    const driver = makeClaudeAdapter({ query: fakeQuery }).open({ cwd: "/x" });
    await driver.send("hello");
    await driver.send("world");
    await new Promise((r) => setTimeout(r, 0)); // let the background drain run
    expect(delivered).toEqual(["hello", "world"]);
  });

  it("throws on send() after close()", async () => {
    const driver = makeClaudeAdapter({ query: () => inertQuery() }).open({ cwd: "/x" });
    await driver.close();
    await expect(driver.send("late")).rejects.toThrow(/after close/);
  });
});
