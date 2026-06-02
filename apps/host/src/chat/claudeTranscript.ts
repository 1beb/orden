// Parse a Claude Code on-disk session transcript (JSONL) into the normalized
// ChatMessage[] the chat view renders. This is how the Chat tab MIRRORS a live
// terminal claude session: claude has no API for a tmux session, it only
// persists to ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl, so we read
// that file (and the caller re-reads it on change for live updates).
//
// The transcript entries are SDK-message-shaped: a top-level `type` of "user"
// or "assistant" with a `message: { id, role, content }`, where assistant
// content is an array of {type:"text"} / {type:"thinking"} / {type:"tool_use"}
// blocks and a user turn is either a string prompt or an array carrying
// {type:"tool_result"} blocks. Other line types (ai-title, mode, attachment, …)
// and subagent sidechains are skipped. Never throws on malformed lines.
import type { ChatMessage, ChatPart } from "@orden/chat-core";

interface RawBlock {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
}

interface RawEntry {
  type?: string;
  isSidechain?: boolean;
  uuid?: string;
  message?: {
    id?: string;
    role?: string;
    content?: unknown;
    usage?: { output_tokens?: number };
  };
}

// Claude injects synthetic "user" entries into the transcript that aren't things
// the human typed — slash-command plumbing, local command output, caveats, hook
// notes. They all begin with a known wrapper tag. Skip them so the mirrored chat
// shows the real conversation, not claude's internal bookkeeping.
const SYNTHETIC_USER_PREFIXES = [
  "<local-command-caveat>",
  "<command-name>",
  "<command-message>",
  "<command-args>",
  "<command-contents>",
  "<bash-input>",
  "<bash-stdout>",
  "<bash-stderr>",
  "<user-prompt-submit-hook>",
];

function isSyntheticUserText(text: string): boolean {
  const t = text.trimStart();
  return SYNTHETIC_USER_PREFIXES.some((p) => t.startsWith(p));
}

function stringifyToolContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) =>
        typeof c === "string"
          ? c
          : c && typeof c === "object" && (c as RawBlock).type === "text"
            ? ((c as RawBlock).text ?? "")
            : JSON.stringify(c),
      )
      .join("");
  }
  if (content == null) return "";
  return JSON.stringify(content);
}

export function parseClaudeTranscript(raw: string): ChatMessage[] {
  const messages: ChatMessage[] = [];
  // toolId -> where its tool part lives, so a later tool_result flips its state.
  const toolIndex = new Map<string, { mi: number; pi: number }>();

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let e: RawEntry;
    try {
      e = JSON.parse(trimmed) as RawEntry;
    } catch {
      continue; // skip malformed line
    }
    if (e.isSidechain) continue; // subagent internals — keep the main thread clean
    const msg = e.message;
    if (!msg) continue;

    if (e.type === "assistant" && Array.isArray(msg.content)) {
      const tokens = msg.usage?.output_tokens;
      const parts: ChatPart[] = [];
      for (const block of msg.content as RawBlock[]) {
        if (block?.type === "text" && typeof block.text === "string") {
          parts.push({ type: "text", text: block.text });
        } else if (block?.type === "thinking") {
          const text = block.thinking ?? block.text ?? "";
          parts.push({ type: "thinking", text, ...(tokens != null ? { tokens } : {}) });
        } else if (block?.type === "tool_use") {
          parts.push({
            type: "tool",
            toolId: String(block.id ?? ""),
            name: String(block.name ?? "tool"),
            input: block.input ?? {},
            state: "running",
          });
        }
      }
      if (parts.length === 0) continue;
      const mi = messages.length;
      messages.push({ id: String(msg.id ?? e.uuid ?? `m${mi}`), role: "assistant", parts });
      parts.forEach((p, pi) => {
        if (p.type === "tool") toolIndex.set(p.toolId, { mi, pi });
      });
    } else if (e.type === "user") {
      const content = msg.content;
      if (typeof content === "string") {
        if (!content.trim() || isSyntheticUserText(content)) continue;
        messages.push({
          id: String(e.uuid ?? `u${messages.length}`),
          role: "user",
          parts: [{ type: "text", text: content }],
        });
      } else if (Array.isArray(content)) {
        let userText = "";
        for (const block of content as RawBlock[]) {
          if (block?.type === "tool_result") {
            const ref = toolIndex.get(String(block.tool_use_id ?? ""));
            const part = ref ? messages[ref.mi]?.parts[ref.pi] : undefined;
            if (part && part.type === "tool") {
              part.state = block.is_error ? "error" : "done";
              part.output = stringifyToolContent(block.content);
            }
          } else if (block?.type === "text" && typeof block.text === "string") {
            userText += block.text;
          }
        }
        if (userText.trim() && !isSyntheticUserText(userText)) {
          messages.push({
            id: String(e.uuid ?? `u${messages.length}`),
            role: "user",
            parts: [{ type: "text", text: userText }],
          });
        }
      }
    }
  }
  return messages;
}
