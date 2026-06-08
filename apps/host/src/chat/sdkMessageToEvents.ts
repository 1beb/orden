import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { DriverEvent } from "@orden/chat-core";

// Pure normalization: one SDK message -> zero or more DriverEvents. The SDK
// union is large; we only act on the message kinds the chat engine consumes
// (init / assistant / user-tool-result / result) and ignore everything else.
// Block shapes are narrowed structurally rather than imported from
// @anthropic-ai/sdk so the mapper stays decoupled from that surface.

interface ToolResultPart {
  type?: string;
  text?: string;
}

// tool_result.content may be a string or an array of content parts. Render an
// array by joining its text parts; fall back to JSON for anything unexpected.
function stringifyToolContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = content as ToolResultPart[];
    if (parts.every((p) => p && p.type === "text" && typeof p.text === "string")) {
      return parts.map((p) => p.text).join("\n");
    }
    return JSON.stringify(content);
  }
  if (content == null) return "";
  return JSON.stringify(content);
}

// A stateful translator. When `includePartialMessages` is on, the SDK emits
// token-level `stream_event` deltas AND the final whole `assistant` message for
// the same id. We drive text/thinking from the deltas, then suppress the final
// message's text blocks (which would otherwise double-render) while still
// surfacing its tool_use blocks. The per-stream state (current message id from
// `message_start`, plus the set of ids whose text already streamed) lives in the
// closure, so each driver gets its own instance via `createSdkTranslator()`.
export function createSdkTranslator(): (msg: SDKMessage) => DriverEvent[] {
  let currentMessageId: string | null = null;
  // Ids whose text already streamed via deltas. Intentionally NEVER reset per
  // turn: an id is added on its text_delta and the final whole-message arrives
  // later for that same id; resetting it (e.g. on message_start) would
  // reintroduce the double-render bug.
  const streamedText = new Set<string>();

  return function sdkMessageToEvents(msg: SDKMessage): DriverEvent[] {
    switch (msg.type) {
      case "system": {
        if (msg.subtype === "init") {
          return [
            {
              kind: "session",
              sessionId: msg.session_id,
              slashCommands: msg.slash_commands ?? [],
            },
          ];
        }
        return [];
      }

      case "stream_event": {
        const event = msg.event as { type?: string } & Record<string, unknown>;
        if (event.type === "message_start") {
          const message = event.message as { id?: string } | undefined;
          currentMessageId = message?.id ?? null;
          return [];
        }
        if (event.type === "content_block_delta") {
          const delta = event.delta as
            | ({ type?: string } & Record<string, unknown>)
            | undefined;
          if (!delta || !currentMessageId) return [];
          if (delta.type === "text_delta") {
            streamedText.add(currentMessageId);
            return [{ kind: "text", messageId: currentMessageId, text: delta.text as string }];
          }
          if (delta.type === "thinking_delta") {
            return [
              { kind: "thinking", messageId: currentMessageId, text: delta.thinking as string },
            ];
          }
        }
        return [];
      }

      case "assistant": {
        const out: DriverEvent[] = [];
        const messageId = msg.message.id;
        const content = msg.message.content;
        if (!Array.isArray(content)) return out;
        // If text for this id already streamed via deltas, its text blocks are a
        // duplicate of what the UI rendered token-by-token; skip them. tool_use
        // blocks never stream as text, so always emit those.
        const textAlreadyStreamed = streamedText.has(messageId);
        for (const block of content as unknown as Array<Record<string, unknown>>) {
          if (block.type === "text") {
            if (!textAlreadyStreamed) {
              out.push({ kind: "text", messageId, text: block.text as string });
            }
          } else if (block.type === "tool_use") {
            out.push({
              kind: "tool",
              messageId,
              toolId: block.id as string,
              name: block.name as string,
              input: block.input,
            });
          }
        }
        return out;
      }

      case "user": {
        const content = msg.message.content;
        if (!Array.isArray(content)) return [];
        const out: DriverEvent[] = [];
        for (const block of content as unknown as Array<Record<string, unknown>>) {
          if (block.type === "tool_result") {
            out.push({
              kind: "tool-result",
              toolId: block.tool_use_id as string,
              output: stringifyToolContent(block.content),
              ok: !block.is_error,
            });
          }
        }
        return out;
      }

      case "result":
        return [{ kind: "turn-end" }];

      default:
        return [];
    }
  };
}
