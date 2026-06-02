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
