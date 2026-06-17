import { query as realQuery } from "@anthropic-ai/claude-agent-sdk";
import type {
  CanUseTool,
  Options,
  Query,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  DriverEvent,
  HarnessAdapter,
  HarnessDriver,
  ModelOption,
  SlashCommand,
} from "@orden/chat-core";
import { createSdkTranslator } from "../sdkMessageToEvents";

// The SDK `query` entrypoint, injected so the adapter is testable without a
// live Claude process. Mirrors the real signature exactly.
export type QueryFn = (params: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: Options;
}) => Query;

// A single-producer/single-consumer async queue used as the streaming-input
// `prompt`. `push` feeds user messages; `end` completes the iterator (so the
// query loop and our events generator can terminate on close).
class InputStream implements AsyncIterable<SDKUserMessage> {
  private queue: SDKUserMessage[] = [];
  private waiting: ((r: IteratorResult<SDKUserMessage>) => void) | null = null;
  private _ended = false;

  get ended(): boolean {
    return this._ended;
  }

  push(msg: SDKUserMessage): void {
    if (this._ended) return;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: msg, done: false });
    } else {
      this.queue.push(msg);
    }
  }

  end(): void {
    this._ended = true;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: undefined as never, done: true });
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    while (true) {
      if (this.queue.length > 0) {
        yield this.queue.shift()!;
        continue;
      }
      if (this._ended) return;
      const next = await new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
        this.waiting = resolve;
      });
      if (next.done) return;
      yield next.value;
    }
  }
}

function userMessage(text: string): SDKUserMessage {
  return {
    type: "user",
    parent_tool_use_id: null,
    message: { role: "user", content: text },
  };
}

export function makeClaudeAdapter(deps?: { query?: QueryFn }): HarnessAdapter {
  const query: QueryFn = deps?.query ?? (realQuery as QueryFn);

  return {
    harness: "claude",

    // Dynamically list available Claude models via the SDK. Opens a short-lived
    // query just to call supportedModels(), with a 5-second timeout so a missing
    // or hung Claude process doesn't block the caller forever. Falls back to an
    // empty list on any failure.
    async listModels(): Promise<ModelOption[]> {
      let q: Query | undefined;
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 5_000);
      try {
        q = query({ prompt: "", options: { abortController: ac } });
        const models = await q.supportedModels();
        return models.map((m) => ({
          harness: "claude",
          id: m.value,
          label: m.displayName,
        }));
      } catch {
        return [];
      } finally {
        clearTimeout(timer);
        if (q) {
          try { await q.interrupt(); } catch { /* ignore */ }
        }
      }
    },

    open({ cwd, model }: { cwd: string; model?: string }): HarnessDriver {
      const input = new InputStream();
      const abortController = new AbortController();
      // Ordering contract: the consumer must call onPermission() synchronously
      // after open() — before the first send() — so a tool request never races
      // ahead of cb registration (the model can't ask for a tool pre-send).
      let permissionCb:
        | ((req: { toolName: string; input: unknown; title: string }) => Promise<{
            allow: boolean;
          }>)
        | null = null;

      const canUseTool: CanUseTool = async (toolName, toolInput, opts) => {
        if (!permissionCb) {
          // No UI is listening; deny safely rather than block forever.
          return { behavior: "deny", message: "no permission handler registered" };
        }
        const { allow } = await permissionCb({
          toolName,
          input: toolInput,
          title: opts.title ?? toolName,
        });
        return allow
          ? { behavior: "allow", updatedInput: toolInput }
          : { behavior: "deny", message: "denied by user" };
      };

      const options: Options = {
        model,
        // Spike-proven isolation: 'default' permission mode + no setting sources
        // so the host's own settings/hooks don't leak into chat sessions.
        permissionMode: "default",
        settingSources: [],
        canUseTool,
        abortController,
        // Emit SDKPartialAssistantMessage stream_events so the GUI streams text
        // and thinking live (token-by-token) instead of only whole messages.
        includePartialMessages: true,
      };
      if (cwd) options.cwd = cwd;

      // Start the query eagerly in streaming-input mode; `send` feeds `input`.
      const q = query({ prompt: input, options });

      // Per-driver translator: holds the stream-dedupe state so partial deltas
      // and the final whole assistant message don't double-render this session.
      const translate = createSdkTranslator();

      async function* events(): AsyncGenerator<DriverEvent, void> {
        try {
          for await (const msg of q) {
            yield* translate(msg);
          }
        } finally {
          // The query ended (naturally, by error, or by close): end the input
          // stream so its iterator can't leak waiting for messages forever.
          input.end();
        }
      }

      return {
        events: events(),

        async send(text: string): Promise<void> {
          if (input.ended) {
            throw new Error("claude adapter: send() after close()");
          }
          input.push(userMessage(text));
        },

        async setModel(m: string): Promise<void> {
          await q.setModel(m);
        },

        async listCommands(): Promise<SlashCommand[]> {
          const cmds = await q.supportedCommands();
          return cmds.map((c) => ({ name: c.name, description: c.description }));
        },

        onPermission(cb): void {
          permissionCb = cb;
        },

        async close(): Promise<void> {
          input.end();
          abortController.abort();
          try {
            await q.interrupt();
          } catch {
            // interrupt may reject if the query already finished; ignore.
          }
        },
      };
    },
  };
}
