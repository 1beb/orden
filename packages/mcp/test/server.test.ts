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
  const server = await createMcpServer(host, ctx);
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
      "card_delete",
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

  it("records a doc→session link when an agent panel_opens a project-relative doc", async () => {
    const { host, client } = await connectedClient({ conversationId: "uuid-1" });
    await client.callTool({
      name: "panel_open",
      arguments: { kind: "doc", target: "analysis/report.html" },
    });
    const link = await host.vault.get<{ sessionId: string }>("doclinks", "analysis/report.html");
    expect(link?.sessionId).toBe("s1");
    await client.close();
  });

  it("does not record a link for an absolute (host-root) doc path", async () => {
    const { host, client } = await connectedClient({ conversationId: "uuid-1" });
    await client.callTool({
      name: "panel_open",
      arguments: { kind: "doc", target: "/etc/foo.md" },
    });
    const link = await host.vault.get("doclinks", "/etc/foo.md");
    expect(link).toBeNull();
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

  it("rejects a no-target card_delete at the schema boundary (never the session's card)", async () => {
    const { host, client } = await connectedClient({ conversationId: "uuid-1" });
    const res = (await client.callTool({ name: "card_delete", arguments: {} })) as {
      isError?: boolean;
      content: Array<{ type: string; text?: string }>;
    };
    expect(res.isError).toBe(true);
    // The bound session's card survives: deletion demands an explicit target.
    expect(await host.vault.get("cards", "c1")).not.toBeNull();
    await client.close();
  });

  it("card_delete by id removes the card but keeps the linked session", async () => {
    const { host, client } = await connectedClient({ conversationId: "uuid-1" });
    const res = (await client.callTool({
      name: "card_delete",
      arguments: { target: "c1" },
    })) as { content: Array<{ type: string; text?: string }> };
    expect(resultText(res)).toBe('deleted card "Fix login" (c1); linked sessions left intact: s1');
    expect(await host.vault.get("cards", "c1")).toBeNull();
    expect(await host.vault.get("sessions", "s1")).not.toBeNull();
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

// A bound session that runs in its own worktree: doc_render / panel_open must
// resolve against session:<id> (the worktree root) instead of the project.
describe("worktree-scoped doc tools", () => {
  function worktreeHost(workdir?: string) {
    const vault = fakeVault({
      sessions: { s1: { id: "s1", conversationId: "uuid-1", projectId: "p1", ...(workdir ? { workdir } : {}) } },
      cards: {
        c1: { id: "c1", title: "Fix login", state: "planning", projectId: "p1", sessionIds: ["s1"] },
      },
      projects: { p1: { id: "p1", name: "Proj" } },
    });
    const rendered: string[][] = [];
    const host = {
      vault,
      render: async (projectId: string, path: string) => {
        rendered.push([projectId, path]);
        return { ok: true, outputPath: path.replace(/\.qmd$/, ".html") };
      },
    } as unknown as Host;
    return { host, rendered };
  }

  async function clientFor(host: Host) {
    const server = await createMcpServer(host, { conversationId: "uuid-1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return client;
  }

  it("doc_render uses session:<id> as the root when the session has a workdir", async () => {
    const { host, rendered } = worktreeHost("/home/u/.orden/worktrees/p1/s1");
    const client = await clientFor(host);
    await client.callTool({ name: "doc_render", arguments: { path: "docs/r.qmd" } });
    expect(rendered).toEqual([["session:s1", "docs/r.qmd"]]);
    await client.close();
  });

  it("doc_render falls back to the session's project without a workdir", async () => {
    const { host, rendered } = worktreeHost(undefined);
    const client = await clientFor(host);
    await client.callTool({ name: "doc_render", arguments: { path: "docs/r.qmd" } });
    expect(rendered).toEqual([["p1", "docs/r.qmd"]]);
    await client.close();
  });

  it("panel_open(doc) stamps the session worktree root on the intent", async () => {
    const { host } = worktreeHost("/home/u/.orden/worktrees/p1/s1");
    const client = await clientFor(host);
    await client.callTool({ name: "panel_open", arguments: { kind: "doc", target: "docs/r.html" } });
    const intent = await host.vault.get<Record<string, unknown>>("ui", "panel-intent");
    expect(intent).toMatchObject({ kind: "doc", target: "docs/r.html", projectId: "session:s1" });
    await client.close();
  });
});
