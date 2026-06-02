import { describe, it, expect } from "vitest";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { sdkMessageToEvents } from "../../src/chat/sdkMessageToEvents";

// Fixtures are typed as SDKMessage via `as` casts: we hand-build only the
// fields the mapper reads, which is the documented (and tested) contract.

describe("sdkMessageToEvents", () => {
  it("maps the init system message to a session event", () => {
    const msg = {
      type: "system",
      subtype: "init",
      session_id: "sess-1",
      slash_commands: ["commit", "review"],
    } as unknown as SDKMessage;

    expect(sdkMessageToEvents(msg)).toEqual([
      { kind: "session", sessionId: "sess-1", slashCommands: ["commit", "review"] },
    ]);
  });

  it("maps an assistant text-only message to one text event", () => {
    const msg = {
      type: "assistant",
      session_id: "sess-1",
      message: { id: "msg-1", content: [{ type: "text", text: "hello" }] },
    } as unknown as SDKMessage;

    expect(sdkMessageToEvents(msg)).toEqual([
      { kind: "text", messageId: "msg-1", text: "hello" },
    ]);
  });

  it("maps an assistant text+tool_use message to two events with the same messageId", () => {
    const msg = {
      type: "assistant",
      session_id: "sess-1",
      message: {
        id: "msg-2",
        content: [
          { type: "text", text: "running a tool" },
          { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "ls" } },
        ],
      },
    } as unknown as SDKMessage;

    expect(sdkMessageToEvents(msg)).toEqual([
      { kind: "text", messageId: "msg-2", text: "running a tool" },
      {
        kind: "tool",
        messageId: "msg-2",
        toolId: "tool-1",
        name: "Bash",
        input: { command: "ls" },
      },
    ]);
  });

  it("maps a user tool_result (string content, ok) to a tool-result event", () => {
    const msg = {
      type: "user",
      session_id: "sess-1",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tool-1", content: "file-a\nfile-b" }],
      },
    } as unknown as SDKMessage;

    expect(sdkMessageToEvents(msg)).toEqual([
      { kind: "tool-result", toolId: "tool-1", output: "file-a\nfile-b", ok: true },
    ]);
  });

  it("maps a user tool_result (array content) by stringifying text parts", () => {
    const msg = {
      type: "user",
      session_id: "sess-1",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-2",
            content: [
              { type: "text", text: "line one" },
              { type: "text", text: "line two" },
            ],
          },
        ],
      },
    } as unknown as SDKMessage;

    expect(sdkMessageToEvents(msg)).toEqual([
      { kind: "tool-result", toolId: "tool-2", output: "line one\nline two", ok: true },
    ]);
  });

  it("maps a user tool_result with is_error to ok:false", () => {
    const msg = {
      type: "user",
      session_id: "sess-1",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tool-3", content: "boom", is_error: true },
        ],
      },
    } as unknown as SDKMessage;

    expect(sdkMessageToEvents(msg)).toEqual([
      { kind: "tool-result", toolId: "tool-3", output: "boom", ok: false },
    ]);
  });

  it("ignores a plain user text message (no tool_result blocks)", () => {
    const msg = {
      type: "user",
      session_id: "sess-1",
      message: { role: "user", content: "just a string prompt" },
    } as unknown as SDKMessage;

    expect(sdkMessageToEvents(msg)).toEqual([]);
  });

  it("maps a result message to a turn-end event", () => {
    const msg = {
      type: "result",
      subtype: "success",
      session_id: "sess-1",
      result: "done",
    } as unknown as SDKMessage;

    expect(sdkMessageToEvents(msg)).toEqual([{ kind: "turn-end" }]);
  });

  it("ignores unknown / non-init system messages", () => {
    const apiRetry = { type: "system", subtype: "api_retry" } as unknown as SDKMessage;
    const compact = {
      type: "system",
      subtype: "compact_boundary",
    } as unknown as SDKMessage;

    expect(sdkMessageToEvents(apiRetry)).toEqual([]);
    expect(sdkMessageToEvents(compact)).toEqual([]);
  });
});
