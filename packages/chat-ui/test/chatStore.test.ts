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

describe("chatStore hydrateKeyed (real-seq aware)", () => {
  // The terminal mirror keys messages by their ABSOLUTE position in the parsed
  // transcript and only writes a sliding window of the most recent ones, so the
  // on-disk msg:<seq> keys can start at an offset (e.g. 481, not 0) and have
  // gaps. Hydrating by array position then diverges from live deltas (which use
  // the real seq), reordering/duplicating messages. hydrateKeyed seeds the store
  // at the REAL seq so both paths share one keyspace.
  const ns = `chat:${SID}`;

  it("seeds messages at their real seq; a live update to the last one replaces in place", () => {
    const store = createChatStore(SID);
    store.hydrateKeyed([
      { seq: 481, message: msg("a", "old-1") },
      { seq: 482, message: msg("b", "old-2") },
      { seq: 483, message: msg("c", "streaming") },
    ]);
    expect(store.messages().map((m) => m.id)).toEqual(["a", "b", "c"]);
    // The still-streaming last message updates, keyed by its REAL seq (483),
    // not its array position (2).
    store.applyChange(ns, "msg:0483", msg("c", "streaming done"));
    expect(store.messages().map((m) => m.id)).toEqual(["a", "b", "c"]); // no duplicate
    expect(store.messages()[2].parts).toEqual([{ type: "text", text: "streaming done" }]);
    // A brand-new appended message (real seq 484) lands AFTER history.
    store.applyChange(ns, "msg:0484", msg("d", "new"));
    expect(store.messages().map((m) => m.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("a live update to an EARLY message in an offset keyspace stays in place — no reorder/dup", () => {
    const store = createChatStore(SID);
    store.hydrateKeyed([
      { seq: 481, message: msg("a", "first") },
      { seq: 482, message: msg("b", "second") },
      { seq: 483, message: msg("c", "third") },
    ]);
    // A tool_result flips the FIRST history message, keyed by real seq 481.
    // With array-index hydration this lands at seq 481 (after everything) and
    // the message appears duplicated at the end.
    store.applyChange(ns, "msg:0481", msg("a", "first updated"));
    expect(store.messages().map((m) => m.id)).toEqual(["a", "b", "c"]);
    expect(store.messages()[0].parts).toEqual([{ type: "text", text: "first updated" }]);
  });

  it("tolerates gaps in the seq keyspace, ordering by real seq", () => {
    const store = createChatStore(SID);
    store.hydrateKeyed([
      { seq: 0, message: msg("a", "A") },
      { seq: 1, message: msg("b", "B") },
      { seq: 100, message: msg("y", "Y") }, // gap 2..99
      { seq: 101, message: msg("z", "Z") },
    ]);
    expect(store.messages().map((m) => m.id)).toEqual(["a", "b", "y", "z"]);
    store.applyChange(ns, "msg:0100", msg("y", "Y2")); // update across the gap
    expect(store.messages().map((m) => m.id)).toEqual(["a", "b", "y", "z"]);
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

describe("chatStore addMessage (optimistic local echo)", () => {
  const ns = `chat:${SID}`;
  function userMsg(id: string, text: string): ChatMessage {
    return { id, role: "user", parts: [{ type: "text", text }] };
  }

  it("shows an optimistically-added user message immediately, after existing history", () => {
    const store = createChatStore(SID);
    store.hydrateKeyed([{ seq: 200, message: msg("a200", "prior turn") }]);
    store.addMessage(userMsg("u1", "hello"));
    expect(store.messages().map((m) => m.id)).toEqual(["a200", "u1"]);
  });

  it("does NOT clobber the optimistic user message when a mid-turn mirror delta lands on the next seq", () => {
    // The bug: addMessage used to place the user echo at maxSeq+1 inside the
    // mirror's keyspace; the agent's in-flight transcript entry at that seq then
    // overwrote it and the user's message vanished ("looks like it didn't send").
    const store = createChatStore(SID);
    store.hydrateKeyed([{ seq: 200, message: msg("a200", "prior turn") }]);
    store.addMessage(userMsg("u1", "hello"));
    // Agent is mid-turn: the mirror writes the turn's NEXT entry at seq 201.
    store.applyChange(ns, "msg:0201", msg("a201", "tool call"));
    const ids = store.messages().map((m) => m.id);
    expect(ids).toContain("u1"); // survived
    expect(ids).toContain("a201");
  });

  it("reconciles the optimistic echo once the transcript records the same user turn (claude)", () => {
    const store = createChatStore(SID);
    store.hydrateKeyed([{ seq: 200, message: msg("a200", "prior turn") }]);
    store.addMessage(userMsg("u1", "hello"));
    // claude later writes the user turn to the transcript at its real seq.
    store.applyChange(ns, "msg:0201", userMsg("real-u", "hello"));
    const users = store.messages().filter((m) => m.role === "user");
    expect(users.length).toBe(1); // no duplicate "hello" bubble
    expect(users[0].id).toBe("real-u"); // the real one wins
  });

  it("persists the optimistic echo for opencode (translator drops user parts) and orders it before the reply", () => {
    const store = createChatStore(SID); // empty: opencode's first turn
    store.addMessage(userMsg("u1", "hi"));
    // Only assistant deltas ever arrive; the user message is never re-added.
    store.applyChange(ns, "msg:0000", msg("a", "assistant reply"));
    expect(store.messages().map((m) => m.id)).toEqual(["u1", "a"]);
  });

  it("fires onChange when an optimistic message is added", () => {
    const store = createChatStore(SID);
    const cb = vi.fn();
    store.onChange(cb);
    store.addMessage(userMsg("u1", "hello"));
    expect(cb).toHaveBeenCalledTimes(1);
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
