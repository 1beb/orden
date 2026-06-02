import { describe, it, expect } from "vitest";
import type { Host, ChatBackend } from "../src/index";

// Compile-level guard: Host.chat must be typed as ChatBackend | undefined.
function readChat(host: Host): ChatBackend | undefined {
  return host.chat;
}

describe("Host.chat", () => {
  it("is typed as ChatBackend | undefined", () => {
    const host = { chat: undefined } as unknown as Host;
    expect(readChat(host)).toBeUndefined();
  });
});
