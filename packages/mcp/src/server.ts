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
- Proactively panel_open any doc you write or render for review (md/html/qmd/ipynb) the moment it is ready — don't wait to be asked. Use panel_open for the board, a page, or a card too when it helps.
- If the orden MCP server drops mid-session (tools vanish), the host mirrors panel_open + card_move + card_create over plain HTTP at POST http://127.0.0.1:$ORDEN_PORT/agent/{panel-open,card-move,card-create}?orden_session_id=$ORDEN_SESSION_ID — curl them from a shell so the panel and board keep working.
- card_get/card_move with no target act on THIS session's card.
__WORKFLOWS__
- A workflow is a typed runbook (ordered steps) that drives a card's lifecycle. When the user describes HOW a task should run (plan, approve, implement, review, publish), help them author one with the workflow_* tools.
- workflow_list shows the available workflows + descriptions; suggest the best fit for a task, then the user confirms via workflow_propose (binds it to THIS session).
- To AUTHOR a workflow: write it as markdown (frontmatter name/description + a numbered list of typed steps). Step kinds: "prose — Label" (drive the agent), "gate: approve|review — Label" (a pause for the user), "do: <action> — Label" (a host effect). Actions: journal, push, open-pr, merge, reap, propose-learnings, run, check, capture, code-review, notify, verify. Call workflow_validate before workflow_save; surface warnings (no approval gate, merging unreviewed work, nothing publishes) to the user.
- A non-default workflow makes the runbook ENGINE drive the card (board projection from the active step, gates as durable pauses, terminal steps as executors). The default workflow is unchanged — existing behavior.`;

const DEFAULT_LEARNINGS_LINES =
  "- Right BEFORE card_complete, distill what this session changed into learnings: call learning_propose once per proposed README/ADR/AGENTS.md edit or new skill, passing the FULL post-change file content (not a diff). The user reviews each one. Do NOT propose memories, and skip it when nothing was worth capturing.\n" +
  "- A Comment on a proposed learning is a request to REVISE that learning: re-run learning_propose with that learning's id (passed as the id arg) and the updated full file content — it replaces the proposal in place and returns it to pending for re-review. Do not create a new learning for a revision.";

// The workflow-authoring guidance appended to the server instructions. Sourced
// from @orden/workflows COMPILE_PROMPT so the catalog + process stay in one
// place; condensed for the instruction surface (the full prompt is available to
// the agent via the workflow_* tool descriptions).
const DEFAULT_WORKFLOW_LINES =
  "- When the user wants to customize HOW a task runs (lifecycle, gates, publish policy), author a workflow runbook: workflow_list to see options, suggest a fit, they confirm with workflow_propose. To author a new one, write markdown (frontmatter + numbered typed steps: prose / gate: approve|review / do: <action>), workflow_validate, then workflow_save. Bind it with workflow_propose.\n" +
  "- The closed action catalog: journal, push, open-pr, merge, reap, propose-learnings (terminal); run, check, capture, code-review, notify, verify (active). Gates: approve, review. A non-default workflow makes the engine drive the card (board projection + durable gates + terminal executors); default is unchanged.";

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
    {
      instructions: INSTRUCTIONS.replace("__LEARNINGS__", learningLines).replace(
        "__WORKFLOWS__",
        DEFAULT_WORKFLOW_LINES,
      ),
    },
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
    "resolution_report",
    {
      description:
        "Report the outcome of a merge-conflict reconciliation. ONLY for ephemeral resolver sessions the merge coordinator spawned. Call exactly once when done: kind 'resolved' after you committed a reconciliation that honors both goals; 'intent-conflict' (with a goal-level question) when the goals genuinely contradict and a human must choose; 'unverifiable' when you cannot produce a reconciliation that will pass the project's checks.",
      inputSchema: {
        kind: z.enum(["resolved", "intent-conflict", "unverifiable"]),
        question: z
          .string()
          .optional()
          .describe("goal-level question for the user (required for intent-conflict / unverifiable)"),
      },
    },
    async ({ kind, question }) =>
      tools.resolutionReport(host.vault, await currentSessionId(), kind, question),
  );

  server.registerTool(
    "project_list",
    { description: "List the orden projects (id and name).", inputSchema: {} },
    () => tools.projectList(host.vault),
  );

  server.registerTool(
    "panel_open",
    {
      description:
        "Surface a doc, page, the kanban board, or a card in the user's main panel. A doc target may be project-relative OR an absolute path (e.g. /home/user/.config/x.md) — an absolute path opens directly, no project needed.",
      inputSchema: {
        kind: z.enum(["doc", "page", "kanban", "card"]),
        target: z
          .string()
          .optional()
          .describe("doc path (project-relative or absolute), page name, or card id/title; omit for kanban"),
      },
    },
    async ({ kind, target }) =>
      tools.panelOpen(
        host.vault,
        kind,
        target ?? "",
        // Docs resolve against the session's worktree when it has one, so an
        // agent can surface files it just wrote there. An ABSOLUTE target isn't a
        // project file at all — the user asked to see a specific path on disk — so
        // route it through the "host" root (any absolute path, no project needed).
        kind === "doc" ? (target?.startsWith("/") ? "host" : await currentRootId()) : undefined,
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

  // --- workflow_* tools (agent-assisted authoring + selection) ---------------
  server.registerTool(
    "workflow_list",
    {
      description:
        "List the available workflows (built-in presets + saved) with their descriptions, so you can suggest the right one for a task.",
      inputSchema: {},
    },
    () => tools.workflowList(host.vault),
  );

  server.registerTool(
    "workflow_validate",
    {
      description:
        "Validate a workflow markdown source. Returns errors (unrunnable) and warnings (trade-offs) plus the step count. Call before workflow_save to confirm the runbook is sound.",
      inputSchema: {
        markdown: z.string().describe("the workflow markdown (frontmatter + numbered typed steps)"),
      },
    },
    ({ markdown }) => tools.workflowValidate(markdown),
  );

  server.registerTool(
    "workflow_save",
    {
      description:
        "Save a workflow markdown to the vault so it appears in the Workflows view and the picker. The frontmatter `name:` is the key (no ':' or leading '__'). Validate first.",
      inputSchema: {
        markdown: z.string().describe("the workflow markdown to save"),
      },
    },
    ({ markdown }) => tools.workflowSave(host.vault, markdown),
  );

  server.registerTool(
    "workflow_render",
    {
      description:
        "Render a named workflow (preset or saved) as readable runbook markdown — to read back a workflow's steps.",
      inputSchema: { name: z.string().describe("workflow name") },
    },
    ({ name }) => tools.workflowRender(host.vault, name),
  );

  server.registerTool(
    "workflow_propose",
    {
      description:
        "Bind a workflow to THIS session (the selection-confirm step). Sets session.workflow; the runbook engine drives the card when the name is non-default. Suggest a workflow from the task intent (read descriptions via workflow_list), then the operator confirms.",
      inputSchema: {
        workflow: z.string().describe("workflow name to bind (e.g. 'bugfix', 'default')"),
      },
    },
    async ({ workflow }) => {
      const sessionId = await currentSessionId();
      if (!sessionId) return unbound();
      return tools.workflowPropose(host.vault, sessionId, workflow);
    },
  );

  server.registerTool(
    "workflow_advance",
    {
      description:
        "Advance THIS session's card through its runbook: approve/reject a gate step, or signal a prose step is complete. This is how the operator moves a workflow-driven card forward past a gate. No-op for a default-workflow card.",
      inputSchema: {
        signal: z
          .enum(["approve", "reject", "complete"])
          .describe("'approve'/'reject' a gate; 'complete' to finish a prose step"),
      },
    },
    async ({ signal }) => {
      const cardId = await currentCardId();
      if (!cardId) return unbound();
      return tools.workflowAdvance(host.vault, cardId, signal);
    },
  );

  return server;
}
