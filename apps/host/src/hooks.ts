// Receives Claude Code hook callbacks (POST /hooks/session-state?state=X) and
// reflects the agent's live state onto the session's linked kanban card:
//   - UserPromptSubmit  -> state "in-progress" (Claude is working/thinking)
//   - Stop              -> state "blocked"     (Claude finished, awaiting you)
//
// The orden-launched `claude --session-id <uuid>` writes <uuid> as the session
// record's conversationId, and Claude's hook payload carries that same id as
// `session_id` — so we map payload.session_id -> session.conversationId ->
// the session -> its linked card. Unknown ids (e.g. the user's own unrelated
// Claude sessions) simply no-op. Always replies 200 so a hook never blocks Claude.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Host } from "@orden/host-api";

interface SessionRec {
  id: string;
  conversationId?: string;
  [k: string]: unknown;
}
interface CardRec {
  id: string;
  state: string;
  sessionId?: string;
  [k: string]: unknown;
}

const ALLOWED = new Set(["in-progress", "blocked", "planning", "complete"]);

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(""));
  });
}

export async function handleHookRequest(
  host: Host,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const ok = (): void => void res.writeHead(200, { "content-type": "application/json" }).end("{}");
  try {
    const state = new URL(req.url ?? "", "http://localhost").searchParams.get("state") ?? "";
    if (!ALLOWED.has(state)) {
      res.writeHead(400, { "content-type": "application/json" }).end('{"error":"bad state"}');
      return;
    }
    const body = await readBody(req);
    let sessionId: string | undefined;
    try {
      sessionId = (JSON.parse(body || "{}") as { session_id?: string }).session_id;
    } catch {
      /* malformed payload — no-op */
    }
    if (sessionId) await applyState(host, sessionId, state);
    ok();
  } catch {
    ok(); // never surface an error to Claude — a failing hook must not block it
  }
}

async function applyState(host: Host, claudeSessionId: string, state: string): Promise<void> {
  const sessionIds = await host.vault.list("sessions");
  let ordenSessionId: string | undefined;
  for (const id of sessionIds) {
    const rec = await host.vault.get<SessionRec>("sessions", id);
    if (rec?.conversationId === claudeSessionId) {
      ordenSessionId = rec.id;
      break;
    }
  }
  if (!ordenSessionId) return; // not an orden-tracked session
  const cardIds = await host.vault.list("cards");
  for (const cid of cardIds) {
    const card = await host.vault.get<CardRec>("cards", cid);
    if (card?.sessionId === ordenSessionId) {
      if (card.state !== state) await host.vault.set("cards", cid, { ...card, state });
      return;
    }
  }
}
