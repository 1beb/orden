import { describe, it, expect } from "vitest";
import { VaultReducer } from "../src/reduceToVault";
import type { ChatSession, ChatMessage } from "../src/index";
import { MemVault } from "./helpers/memVault";

const ns = (id: string) => `chat:${id}`;

describe("VaultReducer: session event", () => {
  it("creates minimal meta when none exists", async () => {
    const vault = new MemVault();
    const r = new VaultReducer(vault, "s1");
    await r.apply({ kind: "session", sessionId: "s1", slashCommands: ["/commit"] });

    const meta = await vault.get<ChatSession>(ns("s1"), "meta");
    expect(meta).not.toBeNull();
    expect(meta!.id).toBe("s1");
    expect((meta as unknown as { slashCommands: string[] }).slashCommands).toEqual(["/commit"]);
  });

  it("merges onto existing meta, preserving other fields", async () => {
    const vault = new MemVault();
    const existing: ChatSession = {
      id: "s1",
      title: "My chat",
      harness: "claude",
      cwd: "/tmp",
      createdAt: 123,
    };
    await vault.set(ns("s1"), "meta", existing);

    const r = new VaultReducer(vault, "s1");
    await r.apply({ kind: "session", sessionId: "resolved-id", slashCommands: ["/a", "/b"] });

    const meta = await vault.get<ChatSession>(ns("s1"), "meta");
    expect(meta!.title).toBe("My chat");
    expect(meta!.cwd).toBe("/tmp");
    expect(meta!.createdAt).toBe(123);
    expect(meta!.id).toBe("resolved-id");
    expect((meta as unknown as { slashCommands: string[] }).slashCommands).toEqual(["/a", "/b"]);
  });
});

describe("VaultReducer: text event", () => {
  it("starts an assistant message with a text part", async () => {
    const vault = new MemVault();
    const r = new VaultReducer(vault, "s1");
    await r.apply({ kind: "text", messageId: "m1", text: "hello" });

    const msg = await vault.get<ChatMessage>(ns("s1"), "msg:0000");
    expect(msg).not.toBeNull();
    expect(msg!.id).toBe("m1");
    expect(msg!.role).toBe("assistant");
    expect(msg!.parts).toEqual([{ type: "text", text: "hello" }]);
  });

  it("concatenates consecutive text deltas for the same message into one part", async () => {
    const vault = new MemVault();
    const r = new VaultReducer(vault, "s1");
    await r.apply({ kind: "text", messageId: "m1", text: "hel" });
    await r.apply({ kind: "text", messageId: "m1", text: "lo" });

    const msg = await vault.get<ChatMessage>(ns("s1"), "msg:0000");
    expect(msg!.parts).toEqual([{ type: "text", text: "hello" }]);
    const keys = await vault.list(ns("s1"));
    expect(keys.filter((k) => k.startsWith("msg:"))).toEqual(["msg:0000"]);
  });
});

describe("VaultReducer: tool event", () => {
  it("adds a running tool part to the current message", async () => {
    const vault = new MemVault();
    const r = new VaultReducer(vault, "s1");
    await r.apply({ kind: "text", messageId: "m1", text: "thinking" });
    await r.apply({
      kind: "tool",
      messageId: "m1",
      toolId: "t1",
      name: "edit",
      input: { path: "a.ts" },
    });

    const msg = await vault.get<ChatMessage>(ns("s1"), "msg:0000");
    expect(msg!.parts).toHaveLength(2);
    expect(msg!.parts[1]).toEqual({
      type: "tool",
      toolId: "t1",
      name: "edit",
      input: { path: "a.ts" },
      state: "running",
    });
  });

  it("starts a message if a tool arrives with no open message", async () => {
    const vault = new MemVault();
    const r = new VaultReducer(vault, "s1");
    await r.apply({
      kind: "tool",
      messageId: "m1",
      toolId: "t1",
      name: "bash",
      input: { cmd: "ls" },
    });

    const msg = await vault.get<ChatMessage>(ns("s1"), "msg:0000");
    expect(msg!.id).toBe("m1");
    expect(msg!.role).toBe("assistant");
    expect(msg!.parts).toHaveLength(1);
    expect(msg!.parts[0].type).toBe("tool");
  });
});
