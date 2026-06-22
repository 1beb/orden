import { describe, it, expect } from "vitest";
import type { Event } from "@opencode-ai/sdk";
import type { DriverEvent } from "@orden/chat-core";
import { OpencodeTranslator } from "../../src/chat/opencodeEventToEvents";

// Build a `message.part.updated` event carrying a text-part snapshot.
function textPart(messageID: string, partId: string, text: string): Event {
  return {
    type: "message.part.updated",
    properties: {
      part: {
        id: partId,
        sessionID: "s1",
        messageID,
        type: "text",
        text,
      },
    },
  } as unknown as Event;
}

// Build a `message.part.updated` event carrying a tool-part snapshot in a state.
function toolPart(
  messageID: string,
  partId: string,
  callID: string,
  tool: string,
  state: Record<string, unknown>,
): Event {
  return {
    type: "message.part.updated",
    properties: {
      part: {
        id: partId,
        sessionID: "s1",
        messageID,
        type: "tool",
        callID,
        tool,
        state,
      },
    },
  } as unknown as Event;
}

const status = (sessionID: string, type: "idle" | "busy" | "retry"): Event =>
  ({
    type: "session.status",
    properties: { sessionID, status: { type } },
  }) as unknown as Event;

const messageUpdated = (id: string, role: "user" | "assistant"): Event =>
  ({ type: "message.updated", properties: { info: { id, role } } }) as unknown as Event;

describe("OpencodeTranslator", () => {
  it("ignores the user message's own parts; only assistant parts become output", () => {
    const t = new OpencodeTranslator();
    const out: DriverEvent[] = [
      ...t.translate(messageUpdated("mUser", "user")),
      ...t.translate(textPart("mUser", "pU", "Reply with PONG")), // the echoed prompt
      ...t.translate(messageUpdated("mAsst", "assistant")),
      ...t.translate(textPart("mAsst", "pA", "PONG")),
    ];
    expect(out).toEqual([{ kind: "text", messageId: "mAsst", text: "PONG" }]);
  });


  it("emits text deltas, not snapshots, for a growing text part", () => {
    const t = new OpencodeTranslator();
    const out: DriverEvent[] = [
      ...t.translate(textPart("m1", "p1", "Hi")),
      ...t.translate(textPart("m1", "p1", "Hi there")),
    ];
    expect(out).toEqual([
      { kind: "text", messageId: "m1", text: "Hi" },
      { kind: "text", messageId: "m1", text: " there" },
    ]);
  });

  it("ignores a re-emitted identical text snapshot", () => {
    const t = new OpencodeTranslator();
    t.translate(textPart("m1", "p1", "Hi"));
    expect(t.translate(textPart("m1", "p1", "Hi"))).toEqual([]);
  });

  it("emits one tool event across pending -> running, then one ok tool-result on completed", () => {
    const t = new OpencodeTranslator();
    const out: DriverEvent[] = [
      ...t.translate(
        toolPart("m1", "p2", "c1", "bash", { status: "pending", input: { command: "ls" }, raw: "" }),
      ),
      ...t.translate(
        toolPart("m1", "p2", "c1", "bash", { status: "running", input: { command: "ls" }, time: { start: 1 } }),
      ),
      ...t.translate(
        toolPart("m1", "p2", "c1", "bash", {
          status: "completed",
          input: { command: "ls" },
          output: "file.txt",
          title: "ls",
          metadata: {},
          time: { start: 1, end: 2 },
        }),
      ),
    ];
    expect(out).toEqual([
      { kind: "tool", messageId: "m1", toolId: "c1", name: "bash", input: { command: "ls" } },
      { kind: "tool-result", toolId: "c1", output: "file.txt", ok: true },
    ]);
  });

  it("emits a failed tool-result when the tool state becomes error", () => {
    const t = new OpencodeTranslator();
    const out: DriverEvent[] = [
      ...t.translate(
        toolPart("m1", "p2", "c1", "bash", { status: "running", input: {}, time: { start: 1 } }),
      ),
      ...t.translate(
        toolPart("m1", "p2", "c1", "bash", {
          status: "error",
          input: {},
          error: "boom",
          time: { start: 1, end: 2 },
        }),
      ),
    ];
    expect(out).toEqual([
      { kind: "tool", messageId: "m1", toolId: "c1", name: "bash", input: {} },
      { kind: "tool-result", toolId: "c1", output: "boom", ok: false },
    ]);
  });

  it("does not re-emit a tool-result on a repeated completed snapshot", () => {
    const t = new OpencodeTranslator();
    const completed = toolPart("m1", "p2", "c1", "bash", {
      status: "completed",
      input: {},
      output: "ok",
      title: "t",
      metadata: {},
      time: { start: 1, end: 2 },
    });
    t.translate(completed);
    expect(t.translate(completed)).toEqual([]);
  });

  it("maps the ROOT session's status{idle} to a turn-end when no root id is set (safe fallback)", () => {
    const t = new OpencodeTranslator();
    expect(t.translate(status("s1", "idle"))).toEqual([{ kind: "turn-end" }]);
  });

  it("maps the ROOT session's status{idle} to a turn-end", () => {
    const t = new OpencodeTranslator("root-1");
    expect(t.translate(status("root-1", "idle"))).toEqual([{ kind: "turn-end" }]);
  });

  it("does NOT end the turn on a child/subagent status{idle}", () => {
    const t = new OpencodeTranslator("root-1");
    expect(t.translate(status("child-1", "idle"))).toEqual([]);
  });

  it("does NOT end the turn on a title/compaction session status{idle}", () => {
    const t = new OpencodeTranslator("root-1");
    expect(t.translate(status("compact-1", "idle"))).toEqual([]);
  });

  it("after a child status{idle}, the root status{idle} still ends the turn", () => {
    const t = new OpencodeTranslator("root-1");
    expect(t.translate(status("child-1", "idle"))).toEqual([]);
    expect(t.translate(status("root-1", "idle"))).toEqual([{ kind: "turn-end" }]);
  });

  it("does NOT end the turn on status{busy} or status{retry} (agent still working)", () => {
    const t = new OpencodeTranslator("root-1");
    expect(t.translate(status("root-1", "busy"))).toEqual([]);
    expect(t.translate(status("root-1", "retry"))).toEqual([]);
  });

  it("ignores the coarser session.idle (status{idle} is the canonical boundary)", () => {
    const t = new OpencodeTranslator("root-1");
    const idle = {
      type: "session.idle",
      properties: { sessionID: "root-1" },
    } as unknown as Event;
    expect(t.translate(idle)).toEqual([]);
  });

  it("ignores unrelated events", () => {
    const t = new OpencodeTranslator();
    const ev = { type: "file.edited", properties: { file: "x" } } as unknown as Event;
    expect(t.translate(ev)).toEqual([]);
  });
});
