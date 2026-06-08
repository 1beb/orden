// The orden MCP server: exposes the Host (pages + raw vault) as MCP tools so
// agents (claude/opencode) read/write the same vault the web UI uses. This is
// the agent↔orden bus; it wraps the same NodeHost the ws bus serves.
//
// When a connection is session-scoped (ctx.conversationId is the calling
// agent's claude --session-id uuid) the kanban tools bind to "my card": a
// no-target card_get/card_move/card_complete resolves the orden session that
// minted this conversation, then the card linked to it.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Host } from "@orden/host-api";
import * as tools from "./tools";
import type { ToolResult } from "./tools";
import { sessionForConversation, cardForSession } from "./sessionLink";

const INSTRUCTIONS = `You operate the orden kanban for the current session.
- card_move("in-progress") when you start real work; card_move("blocked") only when you genuinely need the user's input or are done with the turn.
- NEVER call card_complete unless the user explicitly tells you to finish, close, or mark something done. When you do, pass a one- or two-sentence summary — it is written to today's journal.
- Use card_set_plan to associate a docs/plans/*.md planning doc with a card.
- Capture stray ideas with session_create — they appear in the planning column for later; they do not interrupt this thread.
- Use panel_open to surface a doc, page, the board, or a card in the user's main panel when it helps.
- card_get/card_move with no target act on THIS session's card.`;

export function createMcpServer(host: Host, ctx?: { conversationId?: string }): McpServer {
  const server = new McpServer({ name: "orden", version: "0.1.0" }, { instructions: INSTRUCTIONS });

  const UNBOUND =
    "no target given and this connection isn't bound to a session card — pass a card id or title";
  const unbound = (): ToolResult => ({ content: [{ type: "text", text: UNBOUND }] });

  async function currentCardId(): Promise<string | null> {
    if (!ctx?.conversationId) return null;
    const session = await sessionForConversation(host.vault, ctx.conversationId);
    if (!session) return null;
    const card = await cardForSession(host.vault, session.id);
    return card?.id ?? null;
  }

  async function currentProjectId(): Promise<string | undefined> {
    if (!ctx?.conversationId) return undefined;
    const session = await sessionForConversation(host.vault, ctx.conversationId);
    return session?.projectId ?? undefined;
  }

  server.registerTool(
    "page_list",
    { description: "List the names of all orden pages.", inputSchema: {} },
    () => tools.pageList(host),
  );

  server.registerTool(
    "page_read",
    {
      description: "Read an orden page's markdown by name.",
      inputSchema: { name: z.string().describe("Page name") },
    },
    ({ name }) => tools.pageRead(host, name),
  );

  server.registerTool(
    "page_write",
    {
      description: "Create or overwrite an orden page with markdown.",
      inputSchema: {
        name: z.string().describe("Page name"),
        markdown: z.string().describe("Page body in markdown"),
      },
    },
    ({ name, markdown }) => tools.pageWrite(host, name, markdown),
  );

  server.registerTool(
    "vault_get",
    {
      description: "Read a raw value from the orden vault by namespace and key.",
      inputSchema: { ns: z.string(), key: z.string() },
    },
    ({ ns, key }) => tools.vaultGet(host, ns, key),
  );

  server.registerTool(
    "vault_set",
    {
      description: "Write a value into the orden vault. value is a JSON string (or raw text).",
      inputSchema: { ns: z.string(), key: z.string(), value: z.string() },
    },
    ({ ns, key, value }) => tools.vaultSet(host, ns, key, value),
  );

  server.registerTool(
    "vault_list",
    {
      description: "List the keys in an orden vault namespace.",
      inputSchema: { ns: z.string() },
    },
    ({ ns }) => tools.vaultList(host, ns),
  );

  // --- kanban / session / project / panel tools ----------------------------

  server.registerTool(
    "card_get",
    {
      description: "Read a kanban card's title, state, project, and notes.",
      inputSchema: {
        target: z
          .string()
          .optional()
          .describe("card id or title; omit to use the current session's card"),
      },
    },
    async ({ target }) => {
      const id = target ?? (await currentCardId());
      if (!id) return unbound();
      return tools.cardGet(host.vault, id);
    },
  );

  server.registerTool(
    "card_move",
    {
      description:
        "Move a kanban card to a new state. card_move(\"in-progress\") when you start work; card_move(\"blocked\") when you need the user. With no target it acts on THIS session's card.",
      inputSchema: {
        state: z
          .enum(["planning", "in-progress", "blocked"])
          .describe("new state (complete is NOT allowed here — use card_complete)"),
        target: z.string().optional().describe("card id or title; omit to use the current session's card"),
        note: z.string().optional().describe("optional one-line reason appended to the card notes"),
      },
    },
    async ({ state, target, note }) => {
      const id = target ?? (await currentCardId());
      if (!id) return unbound();
      return tools.cardMove(host.vault, id, state, note);
    },
  );

  server.registerTool(
    "card_complete",
    {
      description:
        "Mark a card complete. ONLY call this when the user has explicitly told you to finish/close the item. Pass a short summary of what was accomplished — it is appended to today's journal.",
      inputSchema: {
        target: z.string().optional().describe("card id or title; omit to use the current session's card"),
        summary: z
          .string()
          .optional()
          .describe("one- or two-sentence summary of what was done, for the journal entry"),
      },
    },
    async ({ target, summary }) => {
      const id = target ?? (await currentCardId());
      if (!id) return unbound();
      return tools.cardComplete(host.vault, id, summary);
    },
  );

  server.registerTool(
    "card_set_plan",
    {
      description:
        "Associate a planning document (a docs/plans/*.md repo file) with a card. With no target it acts on THIS session's card.",
      inputSchema: {
        path: z.string().describe("repo path under docs/plans/, e.g. docs/plans/2026-06-01-foo.md"),
        target: z.string().optional().describe("card id or title; omit to use the current session's card"),
      },
    },
    async ({ path, target }) => {
      const id = target ?? (await currentCardId());
      if (!id) return unbound();
      return tools.cardSetPlan(host, id, path);
    },
  );

  server.registerTool(
    "card_create",
    {
      description: "Create a new kanban card in the planning column.",
      inputSchema: {
        title: z.string(),
        project: z
          .string()
          .optional()
          .describe("project id or name; defaults to the current session's project"),
        notes: z.string().optional(),
      },
    },
    async ({ title, project, notes }) => {
      return tools.cardCreate(host.vault, title, project ?? (await currentProjectId()), notes);
    },
  );

  server.registerTool(
    "session_create",
    {
      description:
        "Spawn a new orden session (and a linked planning card) to capture a stray idea or follow-up without interrupting this thread.",
      inputSchema: {
        title: z.string(),
        project: z.string().optional().describe("project id or name; defaults to the current session's project"),
        prompt: z
          .string()
          .optional()
          .describe("text handed to the agent on launch; defaults to the title"),
        agent: z.enum(["claude", "opencode"]).optional(),
      },
    },
    async ({ title, project, prompt, agent }) => {
      return tools.sessionCreate(host.vault, {
        title,
        projectIdOrName: project ?? (await currentProjectId()),
        prompt,
        agent,
      });
    },
  );

  server.registerTool(
    "project_list",
    { description: "List the orden projects (id and name).", inputSchema: {} },
    () => tools.projectList(host.vault),
  );

  server.registerTool(
    "panel_open",
    {
      description: "Surface a doc, page, the kanban board, or a card in the user's main panel.",
      inputSchema: {
        kind: z.enum(["doc", "page", "kanban", "card"]),
        target: z
          .string()
          .optional()
          .describe("doc path, page name, or card id/title; omit for kanban"),
      },
    },
    ({ kind, target }) => tools.panelOpen(host.vault, kind, target ?? ""),
  );

  server.registerTool(
    "doc_render",
    {
      description:
        "Render a .qmd/.md document on the host (runs quarto) and return build status. Does NOT open anything — on success, follow with panel_open to surface the output. Two tools on purpose: verify the render before opening.",
      inputSchema: {
        path: z
          .string()
          .describe("project-relative path to the source doc, e.g. docs/report.qmd"),
        project: z
          .string()
          .optional()
          .describe("project id; omit to use this session's project"),
      },
    },
    async ({ path, project }) => {
      const pid = project ?? (await currentProjectId()) ?? "repo";
      return tools.docRender(host, pid, path);
    },
  );

  return server;
}
