import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Host } from "@orden/host-api";
import { createMcpServer } from "../src/server";
import { fakeVault } from "./fakeVault";

function seededHost(): Host {
  const vault = fakeVault({
    sessions: { s1: { id: "s1", conversationId: "uuid-1", projectId: "p1" } },
    cards: {
      c1: { id: "c1", title: "Fix login", state: "planning", projectId: "p1", sessionIds: ["s1"] },
    },
    projects: { p1: { id: "p1", name: "Proj" } },
  });
  // The kanban/session/project/panel tools only touch host.vault.
  return { vault } as unknown as Host;
}

async function connectedClient(ctx?: { conversationId?: string }) {
  const host = seededHost();
  const server = createMcpServer(host, ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { host, client };
}

function resultText(res: { content?: Array<{ type: string; text?: string }> }): string {
  return (res.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
}

describe("createMcpServer registration + binding", () => {
  it("exposes the new kanban/session/project/panel tools", async () => {
    const { client } = await connectedClient({ conversationId: "uuid-1" });
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const n of [
      "card_get",
      "card_move",
      "card_complete",
      "card_set_plan",
      "card_create",
      "session_create",
      "project_list",
      "panel_open",
    ]) {
      expect(names).toContain(n);
    }
    await client.close();
  });

  it("resolves a no-target card_move via the session binding", async () => {
    const { host, client } = await connectedClient({ conversationId: "uuid-1" });
    await client.callTool({ name: "card_move", arguments: { state: "blocked" } });
    const card = await host.vault.get<{ state: string }>("cards", "c1");
    expect(card?.state).toBe("blocked");
    await client.close();
  });

  it("card_get by title reflects the moved state", async () => {
    const { client } = await connectedClient({ conversationId: "uuid-1" });
    await client.callTool({ name: "card_move", arguments: { state: "blocked" } });
    const res = (await client.callTool({
      name: "card_get",
      arguments: { target: "Fix login" },
    })) as { content: Array<{ type: string; text?: string }> };
    expect(resultText(res)).toContain("blocked");
    await client.close();
  });

  it("rejects card_move state:complete at the schema boundary", async () => {
    const { client } = await connectedClient({ conversationId: "uuid-1" });
    const res = (await client.callTool({
      name: "card_move",
      arguments: { state: "complete" },
    })) as { isError?: boolean; content: Array<{ type: string; text?: string }> };
    expect(res.isError).toBe(true);
    expect(resultText(res)).toContain("Invalid");
    await client.close();
  });

  it("a no-target card_get on an unbound connection reports UNBOUND", async () => {
    const { client } = await connectedClient(undefined);
    const res = (await client.callTool({ name: "card_get", arguments: {} })) as {
      content: Array<{ type: string; text?: string }>;
    };
    expect(resultText(res)).toContain("isn't bound to a session card");
    await client.close();
  });
});
