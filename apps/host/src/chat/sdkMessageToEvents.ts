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

export function sdkMessageToEvents(msg: SDKMessage): DriverEvent[] {
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

    case "assistant": {
      const out: DriverEvent[] = [];
      const messageId = msg.message.id;
      const content = msg.message.content;
      if (!Array.isArray(content)) return out;
      for (const block of content as Array<Record<string, unknown>>) {
        if (block.type === "text") {
          out.push({ kind: "text", messageId, text: block.text as string });
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
      for (const block of content as Array<Record<string, unknown>>) {
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
}
