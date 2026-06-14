// Plain-HTTP fallback for the handful of orden MCP tools an agent most needs to
// keep driving the UI: panel_open and the card_* writes. When an agent's MCP
// transport drops mid-session — claude marks the `orden` server "disconnected"
// and won't re-enable it for the rest of the run — those tools vanish, even
// though the host on :ORDEN_PORT is still up and the agent's own shell still
// works. These POST /agent/* routes let the agent curl the SAME tool
// implementations from Bash, keyed by the ORDEN_SESSION_ID baked into its launch
// env (see sessionLaunchEnv in terminal.ts).
//
// One implementation, two transports: every route delegates to the @orden/mcp
// tool fn the MCP server itself calls, so the fallback can never drift from the
// bus. Loopback-only, same bind as the rest of the host; no auth beyond that,
// exactly like /hooks/. Always answers JSON so a curl from the agent can branch
// on `ok`.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Host } from "@orden/host-api";
import {
  panelOpen,
  cardMove,
  cardCreate,
  sessionForConversation,
  cardForSession,
  type ToolResult,
} from "@orden/mcp";

const PREFIX = "/agent/";

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        const v: unknown = JSON.parse(raw);
        resolve(v && typeof v === "object" ? (v as Record<string, unknown>) : {});
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}

const toolText = (r: ToolResult): string => r.content.map((c) => c.text).join("");

function send(res: ServerResponse, status: number, ok: boolean, message: string): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok, message }));
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

// Match the MCP server's currentRootId: a doc target resolves against the
// session's own git worktree (session:<id>, understood by the host's
// project-root resolver) when it has one, else its project — so a path the agent
// wrote in its sandbox renders from that same tree.
async function rootForSession(host: Host, sid: string): Promise<string | undefined> {
  const s = await sessionForConversation(host.vault, sid);
  if (!s) return undefined;
  const workdir = (s as { workdir?: unknown }).workdir;
  if (typeof workdir === "string" && workdir) return `session:${s.id}`;
  return s.projectId ?? undefined;
}

// Resolve "my card" the way the MCP card_* tools do: orden session id -> session
// record -> the card it is linked to.
async function cardIdForSession(host: Host, sid: string | undefined): Promise<string | undefined> {
  if (!sid) return undefined;
  const s = await sessionForConversation(host.vault, sid);
  if (!s) return undefined;
  const card = await cardForSession(host.vault, s.id);
  return card?.id ?? undefined;
}

const PANEL_KINDS = ["doc", "page", "kanban", "card"] as const;
const CARD_STATES = ["planning", "in-progress", "blocked"] as const;

export async function handleAgentRequest(
  host: Host,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const url = new URL(req.url ?? "", "http://localhost");
    if (req.method !== "POST") {
      send(res, 405, false, "POST /agent/<panel-open|card-move|card-create> only");
      return;
    }
    const action = url.pathname.startsWith(PREFIX) ? url.pathname.slice(PREFIX.length) : "";
    const sid = url.searchParams.get("orden_session_id") ?? undefined;
    const body = await readJson(req);

    if (action === "panel-open") {
      const kind = (str(body.kind) ?? "doc") as (typeof PANEL_KINDS)[number];
      if (!PANEL_KINDS.includes(kind)) {
        send(res, 400, false, `bad kind: ${kind}`);
        return;
      }
      const target = str(body.target) ?? "";
      // Honour an explicit projectId; otherwise resolve a doc against the
      // session's worktree root (kanban/page targets need no root).
      let projectId = str(body.projectId);
      if (kind === "doc" && !projectId && sid) projectId = await rootForSession(host, sid);
      send(res, 200, true, toolText(await panelOpen(host.vault, kind, target, projectId)));
      return;
    }

    if (action === "card-move") {
      const state = str(body.state) as (typeof CARD_STATES)[number] | undefined;
      if (!state || !CARD_STATES.includes(state)) {
        send(res, 400, false, `bad state: ${str(body.state) ?? "(none)"}`);
        return;
      }
      const target = str(body.target) ?? (await cardIdForSession(host, sid));
      if (!target) {
        send(res, 400, false, "no card: pass target or a bound orden_session_id");
        return;
      }
      send(res, 200, true, toolText(await cardMove(host.vault, target, state, str(body.note))));
      return;
    }

    if (action === "card-create") {
      const title = str(body.title);
      if (!title) {
        send(res, 400, false, "card-create needs a title");
        return;
      }
      // Default the project to the calling session's when not named.
      let project = str(body.project);
      if (!project && sid) project = (await sessionForConversation(host.vault, sid))?.projectId;
      send(
        res,
        200,
        true,
        toolText(await cardCreate(host.vault, title, project, str(body.notes), str(body.description))),
      );
      return;
    }

    send(res, 404, false, `unknown agent action: ${action || "(none)"}`);
  } catch (err) {
    send(res, 500, false, `agent route error: ${(err as Error).message}`);
  }
}
