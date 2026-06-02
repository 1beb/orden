import { describe, it, expect, vi } from "vitest";
import type { ChatMessage, PermissionRequest } from "@orden/chat-core";
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

  it("preserves hydrated history when a live delta arrives, and updates in place", () => {
    const store = createChatStore(SID);
    store.hydrate([msg("a", "hi"), msg("b", "streaming")]); // seqs 0 and 1
    // A live update to the still-streaming last message (seq 1) must replace it,
    // not drop the earlier hydrated history.
    store.applyChange(`chat:${SID}`, "msg:0001", msg("b", "streaming done"));
    expect(store.messages().map((m) => m.id)).toEqual(["a", "b"]);
    expect(store.messages()[1].parts).toEqual([{ type: "text", text: "streaming done" }]);
    // A brand-new message (seq 2) appends after the hydrated ones.
    store.applyChange(`chat:${SID}`, "msg:0002", msg("c", "new"));
    expect(store.messages().map((m) => m.id)).toEqual(["a", "b", "c"]);
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

describe("chatStore applyChange perm", () => {
  const ns = `chat:${SID}`;
  function perm(id: string): PermissionRequest {
    return { id, toolName: "Bash", input: { cmd: "ls" }, title: `Run ${id}` };
  }

  it("adds a pending permission, and removes it on null deletion", () => {
    const store = createChatStore(SID);
    store.applyChange(ns, "perm:p1", perm("p1"));
    store.applyChange(ns, "perm:p2", perm("p2"));
    expect(store.pendingPermissions().map((p) => p.id)).toEqual(["p1", "p2"]);
    store.applyChange(ns, "perm:p1", null);
    expect(store.pendingPermissions().map((p) => p.id)).toEqual(["p2"]);
  });
});

describe("chatStore applyChange meta + other ns", () => {
  const ns = `chat:${SID}`;
  it("accepts the meta key without crashing or treating it as a message", () => {
    const store = createChatStore(SID);
    store.applyChange(ns, "meta", {
      id: SID,
      title: "T",
      harness: "claude",
      cwd: "/x",
      createdAt: 1,
    });
    expect(store.messages()).toEqual([]);
  });

  it("ignores changes for a different session's ns", () => {
    const store = createChatStore(SID);
    store.applyChange("chat:other", "msg:0000", msg("x", "x"));
    store.applyChange("chat:other", "perm:p", {
      id: "p",
      toolName: "Bash",
      input: {},
      title: "t",
    });
    expect(store.messages()).toEqual([]);
    expect(store.pendingPermissions()).toEqual([]);
  });
});

describe("chatStore onChange", () => {
  const ns = `chat:${SID}`;

  it("fires on every mutating applyChange (msg and perm)", () => {
    const store = createChatStore(SID);
    const cb = vi.fn();
    store.onChange(cb);
    store.applyChange(ns, "msg:0000", msg("a", "A"));
    store.applyChange(ns, "perm:p1", {
      id: "p1",
      toolName: "Bash",
      input: {},
      title: "t",
    });
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it("does not fire for foreign ns", () => {
    const store = createChatStore(SID);
    const cb = vi.fn();
    store.onChange(cb);
    store.applyChange("chat:other", "msg:0000", msg("a", "A"));
    expect(cb).not.toHaveBeenCalled();
  });

  it("unsubscribe stops further calls", () => {
    const store = createChatStore(SID);
    const cb = vi.fn();
    const off = store.onChange(cb);
    store.applyChange(ns, "msg:0000", msg("a", "A"));
    off();
    store.applyChange(ns, "msg:0001", msg("b", "B"));
    expect(cb).toHaveBeenCalledTimes(1);
  });
});
