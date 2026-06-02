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

describe("VaultReducer: tool-result event", () => {
  async function withRunningTool() {
    const vault = new MemVault();
    const r = new VaultReducer(vault, "s1");
    await r.apply({ kind: "tool", messageId: "m1", toolId: "t1", name: "edit", input: {} });
    return { vault, r };
  }

  it("flips a successful tool to done with output", async () => {
    const { vault, r } = await withRunningTool();
    await r.apply({ kind: "tool-result", toolId: "t1", output: "ok", ok: true });

    const msg = await vault.get<ChatMessage>(ns("s1"), "msg:0000");
    const part = msg!.parts[0];
    expect(part.type).toBe("tool");
    if (part.type === "tool") {
      expect(part.state).toBe("done");
      expect(part.output).toBe("ok");
    }
  });

  it("flips a failed tool to error with output", async () => {
    const { vault, r } = await withRunningTool();
    await r.apply({ kind: "tool-result", toolId: "t1", output: "boom", ok: false });

    const msg = await vault.get<ChatMessage>(ns("s1"), "msg:0000");
    const part = msg!.parts[0];
    if (part.type === "tool") {
      expect(part.state).toBe("error");
      expect(part.output).toBe("boom");
    }
  });

  it("ignores a tool-result with no matching tool part (no throw)", async () => {
    const vault = new MemVault();
    const r = new VaultReducer(vault, "s1");
    await r.apply({ kind: "text", messageId: "m1", text: "hi" });
    await expect(
      r.apply({ kind: "tool-result", toolId: "ghost", output: "x", ok: true }),
    ).resolves.toBeUndefined();

    const msg = await vault.get<ChatMessage>(ns("s1"), "msg:0000");
    expect(msg!.parts).toEqual([{ type: "text", text: "hi" }]);
  });
});

describe("VaultReducer: turn-end event", () => {
  it("closes the current message so the next text starts a new one", async () => {
    const vault = new MemVault();
    const r = new VaultReducer(vault, "s1");
    await r.apply({ kind: "text", messageId: "m1", text: "first" });
    await r.apply({ kind: "turn-end" });
    await r.apply({ kind: "text", messageId: "m2", text: "second" });

    const first = await vault.get<ChatMessage>(ns("s1"), "msg:0000");
    const second = await vault.get<ChatMessage>(ns("s1"), "msg:0001");
    expect(first!.id).toBe("m1");
    expect(first!.parts).toEqual([{ type: "text", text: "first" }]);
    expect(second!.id).toBe("m2");
    expect(second!.parts).toEqual([{ type: "text", text: "second" }]);
  });

  it("flips a still-running tool to error defensively", async () => {
    const vault = new MemVault();
    const r = new VaultReducer(vault, "s1");
    await r.apply({ kind: "tool", messageId: "m1", toolId: "t1", name: "edit", input: {} });
    await r.apply({ kind: "turn-end" });

    const msg = await vault.get<ChatMessage>(ns("s1"), "msg:0000");
    const part = msg!.parts[0];
    if (part.type === "tool") {
      expect(part.state).toBe("error");
    }
  });

  it("leaves a resolved tool untouched on turn-end", async () => {
    const vault = new MemVault();
    const r = new VaultReducer(vault, "s1");
    await r.apply({ kind: "tool", messageId: "m1", toolId: "t1", name: "edit", input: {} });
    await r.apply({ kind: "tool-result", toolId: "t1", output: "ok", ok: true });
    await r.apply({ kind: "turn-end" });

    const msg = await vault.get<ChatMessage>(ns("s1"), "msg:0000");
    const part = msg!.parts[0];
    if (part.type === "tool") {
      expect(part.state).toBe("done");
    }
  });

  it("is a no-op when no message is open", async () => {
    const vault = new MemVault();
    const r = new VaultReducer(vault, "s1");
    await expect(r.apply({ kind: "turn-end" })).resolves.toBeUndefined();
    expect(await vault.list(ns("s1"))).toEqual([]);
  });
});

describe("VaultReducer: resume", () => {
  it("appends after existing messages instead of clobbering msg:0000", async () => {
    const vault = new MemVault();
    const prior: ChatMessage = { id: "old", role: "user", parts: [{ type: "text", text: "q" }] };
    await vault.set(ns("s1"), "msg:0000", prior);
    await vault.set(ns("s1"), "meta", {
      id: "s1",
      title: "t",
      harness: "claude",
      cwd: "/",
      createdAt: 1,
    });

    const r = new VaultReducer(vault, "s1");
    await r.apply({ kind: "text", messageId: "m1", text: "answer" });

    const kept = await vault.get<ChatMessage>(ns("s1"), "msg:0000");
    const fresh = await vault.get<ChatMessage>(ns("s1"), "msg:0001");
    expect(kept!.id).toBe("old");
    expect(fresh!.id).toBe("m1");
  });
});
