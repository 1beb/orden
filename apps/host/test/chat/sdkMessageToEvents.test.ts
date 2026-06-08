import { describe, it, expect } from "vitest";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { createSdkTranslator } from "../../src/chat/sdkMessageToEvents";

// Fixtures are typed as SDKMessage via `as` casts: we hand-build only the
// fields the mapper reads, which is the documented (and tested) contract.
// Every test builds its own fresh translator via createSdkTranslator() so no
// per-stream state (dedupe set, current message id) leaks between cases.

const streamEv = (event: unknown) => ({ type: "stream_event", event } as any);

describe("sdkMessageToEvents", () => {
  it("maps the init system message to a session event", () => {
    const translate = createSdkTranslator();
    const msg = {
      type: "system",
      subtype: "init",
      session_id: "sess-1",
      slash_commands: ["commit", "review"],
    } as unknown as SDKMessage;

    expect(translate(msg)).toEqual([
      { kind: "session", sessionId: "sess-1", slashCommands: ["commit", "review"] },
    ]);
  });

  it("maps an assistant text-only message to one text event", () => {
    const translate = createSdkTranslator();
    const msg = {
      type: "assistant",
      session_id: "sess-1",
      message: { id: "msg-1", content: [{ type: "text", text: "hello" }] },
    } as unknown as SDKMessage;

    expect(translate(msg)).toEqual([
      { kind: "text", messageId: "msg-1", text: "hello" },
    ]);
  });

  it("maps an assistant text+tool_use message to two events with the same messageId", () => {
    const translate = createSdkTranslator();
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

    expect(translate(msg)).toEqual([
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
    const translate = createSdkTranslator();
    const msg = {
      type: "user",
      session_id: "sess-1",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tool-1", content: "file-a\nfile-b" }],
      },
    } as unknown as SDKMessage;

    expect(translate(msg)).toEqual([
      { kind: "tool-result", toolId: "tool-1", output: "file-a\nfile-b", ok: true },
    ]);
  });

  it("maps a user tool_result (array content) by stringifying text parts", () => {
    const translate = createSdkTranslator();
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

    expect(translate(msg)).toEqual([
      { kind: "tool-result", toolId: "tool-2", output: "line one\nline two", ok: true },
    ]);
  });

  it("maps a user tool_result with is_error to ok:false", () => {
    const translate = createSdkTranslator();
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

    expect(translate(msg)).toEqual([
      { kind: "tool-result", toolId: "tool-3", output: "boom", ok: false },
    ]);
  });

  it("ignores a plain user text message (no tool_result blocks)", () => {
    const translate = createSdkTranslator();
    const msg = {
      type: "user",
      session_id: "sess-1",
      message: { role: "user", content: "just a string prompt" },
    } as unknown as SDKMessage;

    expect(translate(msg)).toEqual([]);
  });

  it("maps a result message to a turn-end event", () => {
    const translate = createSdkTranslator();
    const msg = {
      type: "result",
      subtype: "success",
      session_id: "sess-1",
      result: "done",
    } as unknown as SDKMessage;

    expect(translate(msg)).toEqual([{ kind: "turn-end" }]);
  });

  it("ignores unknown / non-init system messages", () => {
    const translate = createSdkTranslator();
    const apiRetry = { type: "system", subtype: "api_retry" } as unknown as SDKMessage;
    const compact = {
      type: "system",
      subtype: "compact_boundary",
    } as unknown as SDKMessage;

    expect(translate(apiRetry)).toEqual([]);
    expect(translate(compact)).toEqual([]);
  });
});

describe("sdkMessageToEvents stream_event", () => {
  it("maps a text_delta to a text event using the message_start id", () => {
    const t = createSdkTranslator();
    t(streamEv({ type: "message_start", message: { id: "msg_abc" } }) as any);
    const out = t(streamEv({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } }) as any);
    expect(out).toEqual([{ kind: "text", messageId: "msg_abc", text: "Hi" }]);
  });

  it("maps a thinking_delta to a thinking event", () => {
    const t = createSdkTranslator();
    t(streamEv({ type: "message_start", message: { id: "m" } }) as any);
    const out = t(streamEv({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "ponder" } }) as any);
    expect(out).toEqual([{ kind: "thinking", messageId: "m", text: "ponder" }]);
  });

  it("does NOT re-emit text from the final assistant message when partials streamed it", () => {
    const t = createSdkTranslator();
    t(streamEv({ type: "message_start", message: { id: "msg_abc" } }) as any);
    t(streamEv({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } }) as any);
    const finalAssistant = { type: "assistant", message: { id: "msg_abc", content: [{ type: "text", text: "Hi" }] } } as any;
    const out = t(finalAssistant);
    expect(out.filter((e: any) => e.kind === "text")).toEqual([]);
  });

  it("still emits tool_use from the final assistant message", () => {
    const t = createSdkTranslator();
    t(streamEv({ type: "message_start", message: { id: "msg_t" } }) as any);
    const finalAssistant = { type: "assistant", message: { id: "msg_t", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { cmd: "ls" } }] } } as any;
    const out = t(finalAssistant);
    expect(out).toEqual([{ kind: "tool", messageId: "msg_t", toolId: "t1", name: "Bash", input: { cmd: "ls" } }]);
  });

  it("emits text from a final assistant message when NO partial streamed (non-streaming mode)", () => {
    const t = createSdkTranslator();
    const finalAssistant = { type: "assistant", message: { id: "m2", content: [{ type: "text", text: "whole" }] } } as any;
    const out = t(finalAssistant);
    expect(out).toEqual([{ kind: "text", messageId: "m2", text: "whole" }]);
  });

  it("does not suppress final text when only thinking streamed for that id", () => {
    const t = createSdkTranslator();
    t({ type: "stream_event", event: { type: "message_start", message: { id: "m3" } } } as any);
    t({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "mull" } } } as any);
    const finalAssistant = { type: "assistant", message: { id: "m3", content: [{ type: "text", text: "the answer" }] } } as any;
    const out = t(finalAssistant);
    expect(out).toEqual([{ kind: "text", messageId: "m3", text: "the answer" }]);
  });
});
