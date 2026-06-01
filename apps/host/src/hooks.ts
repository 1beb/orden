// Receives Claude Code hook callbacks (POST /hooks/session-state?state=X) and
// reflects the agent's live state onto the session's linked kanban card:
//   - UserPromptSubmit  -> state "in-progress" (Claude is working/thinking)
//   - PostToolUse       -> state "in-progress" (a tool ran => still working)
//   - Stop              -> state "blocked"     (Claude finished, awaiting you)
//
// PostToolUse is the RECOVERY edge. Without it the cycle is asymmetric: only
// UserPromptSubmit restores in-progress, but a turn can be parked at blocked
// mid-flight by a waiting-notification (a permission or AskUserQuestion prompt).
// Answering that prompt is NOT a new prompt submission, so nothing fired to
// un-block the card and it stayed "blocked" for the rest of the turn while the
// agent was actively working. PostToolUse fires after every completed tool —
// i.e. once the agent is demonstrably working again — so the first tool run
// after the prompt is answered flips the card back to in-progress. It's a no-op
// the rest of the time (applyState only writes on an actual state change), and
// at end-of-turn the trailing Stop still wins (last PostToolUse -> in-progress,
// then Stop -> blocked).
//
// Division of labor: the HOOKS drive the automatic working/waiting cycle only
// (UserPromptSubmit / PostToolUse -> in-progress, Stop / waiting-notification ->
// blocked) and may set just planning | in-progress | blocked. They NEVER touch a
// card that is already "complete" — complete is terminal and user-owned, so
// neither a trailing Stop nor a trailing PostToolUse may knock a just-completed
// card off complete. Deliberate moves — and the ONLY path to "complete" — come
// from the LLM via the MCP `card_*` tools (`card_complete`), not from a hook.
//
// The orden-launched `claude --session-id <uuid>` writes <uuid> as the session
// record's conversationId, and Claude's hook payload carries that same id as
// `session_id` — so we map payload.session_id -> session.conversationId ->
// the session -> its linked card. Unknown ids (e.g. the user's own unrelated
// Claude sessions) simply no-op. Always replies 200 so a hook never blocks Claude.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Host } from "@orden/host-api";
import { sessionForConversation, cardForSession } from "@orden/mcp";

// Hooks may only set the automatic cycle states. "complete" is intentionally
// excluded — it comes solely from the `card_complete` MCP tool.
const ALLOWED = new Set(["in-progress", "blocked", "planning"]);

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
    const url = new URL(req.url ?? "", "http://localhost");
    const body = await readBody(req);
    let payload: { session_id?: string; notification_type?: string } = {};
    try {
      payload = JSON.parse(body || "{}");
    } catch {
      /* malformed payload — no-op */
    }
    const sessionId = payload.session_id;

    // Notification hook: Claude pauses mid-turn waiting on the user (Stop does NOT
    // fire here). Treat the "waiting" notification types as blocked; ignore the
    // rest (e.g. auth_success). The hook posts unfiltered (matcher support for
    // Notification is unreliable), so the decision lives here.
    if (url.pathname.endsWith("/notification")) {
      if (sessionId && WAITING_NOTIFICATIONS.has(payload.notification_type ?? "")) {
        await applyState(host, sessionId, "blocked");
      }
      ok();
      return;
    }

    // session-state: explicit state in the query (UserPromptSubmit -> in-progress,
    // Stop -> blocked).
    const state = url.searchParams.get("state") ?? "";
    if (!ALLOWED.has(state)) {
      res.writeHead(400, { "content-type": "application/json" }).end('{"error":"bad state"}');
      return;
    }
    if (sessionId) await applyState(host, sessionId, state);
    ok();
  } catch {
    ok(); // never surface an error to Claude — a failing hook must not block it
  }
}

// Notification types that mean "Claude is waiting on the human" -> Blocked.
const WAITING_NOTIFICATIONS = new Set([
  "permission_prompt",
  "idle_prompt",
  "elicitation_dialog",
]);

export async function applyState(host: Host, claudeSessionId: string, state: string): Promise<void> {
  const session = await sessionForConversation(host.vault, claudeSessionId);
  if (!session) return; // not an orden-tracked session
  const card = await cardForSession(host.vault, session.id);
  if (!card) return;
  // "complete" is terminal and user/LLM-owned: never let an automatic hook
  // (e.g. a trailing Stop) knock a just-completed card back to blocked.
  if (card.state === "complete") return;
  if (card.state !== state) {
    await host.vault.set("cards", card.id, { ...card, state });
  }
}
