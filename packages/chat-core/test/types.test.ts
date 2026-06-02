import { describe, it, expect } from "vitest";
import type {
  ChatMessage,
  ChatPart,
  ChatBackend,
  HarnessAdapter,
  ChatVault,
} from "../src/index";

describe("chat-core types", () => {
  it("composes a ChatMessage from a text part and a tool part", () => {
    const textPart: ChatPart = { type: "text", text: "hello" };
    const toolPart: ChatPart = {
      type: "tool",
      toolId: "t1",
      name: "edit",
      input: { path: "a.ts" },
      state: "done",
      output: "ok",
    };

    const msg: ChatMessage = {
      id: "m1",
      role: "assistant",
      parts: [textPart, toolPart],
    };

    expect(msg.parts).toHaveLength(2);
    expect(msg.parts[0].type).toBe("text");
    expect(msg.parts[1].type).toBe("tool");

    // Reference the modular contracts as types so the test fails to
    // compile until they exist.
    type _Backend = ChatBackend;
    type _Adapter = HarnessAdapter;
    type _Vault = ChatVault;
    expect(true).toBe(true);
  });
});
