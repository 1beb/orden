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
__LEARNINGS__
- Your session may run in an ISOLATED git worktree on its own orden/<slug> branch. Commit your work there as you go — card_complete verifies a clean tree, pushes the branch, and opens a PR. It REFUSES on uncommitted changes; pass force:true only when the user explicitly says to complete without publishing. NEVER merge to the default branch yourself — integration is the user's process.
- Use card_set_plan to associate a docs/plans/*.md planning doc with a card.
- Capture stray ideas with session_create — they appear in the planning column for later; they do not interrupt this thread.
- Use panel_open to surface a doc, page, the board, or a card in the user's main panel when it helps.
- card_get/card_move with no target act on THIS session's card.`;

const DEFAULT_LEARNINGS_LINES =
  "- Right BEFORE card_complete, distill what this session changed into learnings: call learning_propose once per proposed README/ADR/AGENTS.md edit or new skill, passing the FULL post-change file content (not a diff). The user reviews each one. Do NOT propose memories, and skip it when nothing was worth capturing.\n" +
  "- A Comment on a proposed learning is a request to REVISE that learning: re-run learning_propose with that learning's id (passed as the id arg) and the updated full file content — it replaces the proposal in place and returns it to pending for re-review. Do not create a new learning for a revision.";

export async function createMcpServer(host: Host, ctx?: { conversationId?: string }): Promise<McpServer> {
  let learningLines = DEFAULT_LEARNINGS_LINES;
  try {
    const settings = await host.vault.get<{ learningPrompt?: string }>("settings", "app");
    if (settings?.learningPrompt) learningLines = settings.learningPrompt;
  } catch {
    // vault read failed or no settings; use the default
  }
  const server = new McpServer(
    { name: "orden", version: "0.1.0" },
    { instructions: INSTRUCTIONS.replace("__LEARNINGS__", learningLines) },
  );

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

  async function currentSessionId(): Promise<string | undefined> {
    if (!ctx?.conversationId) return undefined;
    const session = await sessionForConversation(host.vault, ctx.conversationId);
    return session?.id ?? undefined;
  }

  // The file root this session's doc tools should resolve against: its own git
  // worktree when it has one (session:<id>, understood by the host's
  // project-root resolver), else its project. Without this, a worktree session's
  // doc_render/panel_open would resolve paths in the SHARED checkout — a
  // different tree than the one the agent edited.
  async function currentRootId(): Promise<string | undefined> {
    if (!ctx?.conversationId) return undefined;
    const session = await sessionForConversation(host.vault, ctx.conversationId);
    if (!session) return undefined;
    const workdir = (session as { workdir?: unknown }).workdir;
    if (typeof workdir === "string" && workdir) return `session:${session.id}`;
    return session.projectId ?? undefined;
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
        force: z
          .boolean()
          .optional()
          .describe(
            "complete even with unpublished/dirty worktree changes — pass ONLY when the user explicitly said to complete without publishing",
          ),
      },
    },
    async ({ target, summary, force }) => {
      const id = target ?? (await currentCardId());
      if (!id) return unbound();
      // The publish gate (clean-check + push + PR) rides the host's optional
      // capability; standalone hosts complete exactly as before.
      return tools.cardComplete(host.vault, id, summary, {
        force,
        publish: host.publish?.bind(host),
      });
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
        description: z
          .string()
          .optional()
          .describe("free text sent to the agent with the title when a session starts"),
      },
    },
    async ({ title, project, notes, description }) => {
      return tools.cardCreate(
        host.vault,
        title,
        project ?? (await currentProjectId()),
        notes,
        description,
      );
    },
  );

  server.registerTool(
    "card_delete",
    {
      description:
        "Delete a kanban card outright. DESTRUCTIVE — ONLY call this when the user has explicitly told you to delete the card. Requires an explicit card id or title; it NEVER acts on this session's card by default. Linked sessions are left intact.",
      inputSchema: {
        target: z
          .string()
          .describe("card id or title (required — deletion never defaults to the current session's card)"),
      },
    },
    ({ target }) => tools.cardDelete(host.vault, target),
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
    async ({ kind, target }) =>
      tools.panelOpen(
        host.vault,
        kind,
        target ?? "",
        // Docs resolve against the session's worktree when it has one, so an
        // agent can surface files it just wrote there.
        kind === "doc" ? await currentRootId() : undefined,
      ),
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
      // Unlike card_create/session_create, render needs a CONCRETE root to render
      // against, so fall back to "repo" (the resolver's alias for filesRoot) when
      // there's no explicit project and no session binding. A worktree session
      // renders inside its own worktree (currentRootId).
      const pid = project ?? (await currentRootId()) ?? "repo";
      return tools.docRender(host, pid, path);
    },
  );

  server.registerTool(
    "learning_propose",
    {
      description:
        "Propose a learning — a concrete edit to README/ADR/AGENTS.md or a new skill — distilled from this session's work, for the user to review. Provide the FULL post-change file content, not a diff. Call once per proposed change when completing a card. Do NOT propose memories.",
      inputSchema: {
        type: z.enum(["readme", "adr", "agents", "skill"]),
        title: z.string(),
        recap: z.string().describe("1-3 sentences: why this learning, from the session's work"),
        path: z.string().describe("project-relative target file (created if missing)"),
        content: z.string().describe("the FULL proposed file content after the change"),
        id: z
          .string()
          .optional()
          .describe(
            "to REVISE an existing learning (e.g. after the user commented), pass its id — the proposal updates that learning in place; omit to create a new one",
          ),
      },
    },
    async ({ type, title, recap, path, content, id }) => {
      const cardId = await currentCardId();
      if (!cardId) return unbound();
      const projectId = (await currentProjectId()) ?? "repo";
      const sessionId = await currentSessionId();
      return tools.learningPropose(
        host,
        { cardId, projectId, sessionId },
        { type, title, recap, path, content },
        Date.now(),
        id ?? tools.rid("learn"),
      );
    },
  );

  return server;
}
