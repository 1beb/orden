import { describe, it, expect } from "vitest";
import type { Host } from "@orden/host-api";
import { makeChatClient } from "../src/chatClient";

// A fake host whose `chat` records each delegated call. Only the fields
// makeChatClient touches need to exist.
function fakeHostWithChat() {
  const calls: { method: string; args: unknown[] }[] = [];
  const rec =
    (method: string, ret: unknown) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
      return Promise.resolve(ret);
    };
  const chat = {
    listSessions: rec("listSessions", []),
    createSession: rec("createSession", { id: "c1" }),
    getMessages: rec("getMessages", []),
    send: rec("send", undefined),
    respondPermission: rec("respondPermission", undefined),
    setModel: rec("setModel", undefined),
    listModels: rec("listModels", []),
    listCommands: rec("listCommands", []),
  };
  const host = { chat } as unknown as Host;
  return { host, calls };
}

describe("makeChatClient", () => {
  it("delegates every method to host.chat with the same args", async () => {
    const { host, calls } = fakeHostWithChat();
    const client = makeChatClient(host);

    await client.listSessions();
    await client.createSession({ harness: "claude", cwd: ".", title: "T" });
    await client.getMessages("s1");
    await client.send("s1", "hi", { model: "m" });
    await client.respondPermission("s1", "r1", { decision: "allow" });
    await client.setModel("s1", "m2");
    await client.listModels("opencode");
    await client.listCommands("s1");

    expect(calls.map((c) => c.method)).toEqual([
      "listSessions",
      "createSession",
      "getMessages",
      "send",
      "respondPermission",
      "setModel",
      "listModels",
      "listCommands",
    ]);
    expect(calls[1].args).toEqual([{ harness: "claude", cwd: ".", title: "T" }]);
    expect(calls[3].args).toEqual(["s1", "hi", { model: "m" }]);
    expect(calls[4].args).toEqual(["s1", "r1", { decision: "allow" }]);
  });

  it("returns the value from host.chat", async () => {
    const { host } = fakeHostWithChat();
    const client = makeChatClient(host);
    expect(await client.createSession({ harness: "claude", cwd: "." })).toEqual({ id: "c1" });
  });

  it("throws a clear error when host.chat is undefined", () => {
    const host = {} as unknown as Host;
    const client = makeChatClient(host);
    expect(() => client.listSessions()).toThrow("chat backend unavailable");
    expect(() => client.createSession({ harness: "claude", cwd: "." })).toThrow(
      "chat backend unavailable",
    );
  });
});
