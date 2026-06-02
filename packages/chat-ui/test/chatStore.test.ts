import { describe, it, expect, vi } from "vitest";
import type { ChatMessage } from "@orden/chat-core";
import { createChatStore } from "../src/chatStore";

const SID = "sess-1";

function msg(id: string, text: string): ChatMessage {
  return { id, role: "assistant", parts: [{ type: "text", text }] };
}

describe("chatStore hydrate", () => {
  it("sets initial messages and returns them; fires no onChange", () => {
    const store = createChatStore(SID);
    const cb = vi.fn();
    store.onChange(cb);
    store.hydrate([msg("a", "hi"), msg("b", "yo")]);
    expect(store.messages().map((m) => m.id)).toEqual(["a", "b"]);
    expect(cb).not.toHaveBeenCalled();
  });
});
