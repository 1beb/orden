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

describe("chatStore applyChange msg", () => {
  const ns = `chat:${SID}`;

  it("upserts a message by its seq key; a later change replaces it", () => {
    const store = createChatStore(SID);
    store.applyChange(ns, "msg:0000", msg("m", "first"));
    store.applyChange(ns, "msg:0000", msg("m", "second"));
    expect(store.messages()).toEqual([msg("m", "second")]);
  });

  it("two different seqs yield two messages in seq order", () => {
    const store = createChatStore(SID);
    store.applyChange(ns, "msg:0001", msg("b", "B"));
    store.applyChange(ns, "msg:0000", msg("a", "A"));
    expect(store.messages().map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("sorts numerically, not lexically, across the 9->10 boundary", () => {
    const store = createChatStore(SID);
    store.applyChange(ns, "msg:0010", msg("ten", "10"));
    store.applyChange(ns, "msg:0009", msg("nine", "9"));
    store.applyChange(ns, "msg:10000", msg("big", "10000"));
    store.applyChange(ns, "msg:0002", msg("two", "2"));
    expect(store.messages().map((m) => m.id)).toEqual(["two", "nine", "ten", "big"]);
  });
});
