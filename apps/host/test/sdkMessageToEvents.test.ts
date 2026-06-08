import { describe, it, expect } from "vitest";
import { createSdkTranslator } from "../src/chat/sdkMessageToEvents";

const streamEv = (event: unknown) =>
  ({ type: "stream_event", event } as any);

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
