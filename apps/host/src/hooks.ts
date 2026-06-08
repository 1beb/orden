// Receives Claude Code hook callbacks (POST /hooks/session-state?state=X) and
// reflects the agent's live state onto the session's linked kanban card:
//   - UserPromptSubmit  -> state "in-progress" (Claude is working/thinking)
//   - PostToolUse       -> state "in-progress" (a tool ran => still working)
//   - Stop              -> state "blocked"     (Claude finished, awaiting you)
//   - SubagentStart/Stop -> count in-flight subagents (NOT a card state on its own)
//
// SUBAGENT GATING. A "subagent workflow" (the Task tool, and especially a
// BACKGROUND workflow) hands control back to the main agent immediately, so the
// main agent's turn ends — firing Stop — while the spawned subagents keep
// working. A naive Stop->blocked therefore parks the card at blocked the instant
// a subagent workflow is triggered, even though work is plainly ongoing. Both
// SubagentStart and SubagentStop fire carrying the PARENT session_id (verified),
// so we count in-flight subagents per session and GATE Stop on that depth: a
// Stop with subagents still running is a background turn-end, not a wait-on-you,
// so the card stays in-progress.
//
// DEFERRED BLOCK. In the background case the main agent's Stop fires WHILE
// subagents are still running, and NO further Stop follows once they finish (the
// turn already ended). So a gated Stop must not be discarded — it is REMEMBERED
// (pendingBlock) and applied the moment the last subagent stops (depth hits 0).
// Without this the card is trapped at in-progress forever. In the foreground
// case SubagentStop precedes the main Stop, so nothing is pending when depth hits
// 0 (settle is a no-op) and the trailing Stop blocks normally. UserPromptSubmit
// resets both the counter and any pending block — a fresh user turn means prior
// subagents are done and the old deferred Stop is moot — which also bounds a
// missed SubagentStop to a single turn.
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
import { noteHookActivity } from "./idleReconciler";

// Hooks may only set the automatic cycle states. "complete" is intentionally
// excluded — it comes solely from the `card_complete` MCP tool.
const ALLOWED = new Set(["in-progress", "blocked", "planning"]);

// Per-claude-session count of in-flight subagents (keyed by the same id the
// state hooks carry — payload.session_id == session.conversationId). A long-
// lived module Map is fine: the host is one process, and a restart resets the
// counts to 0, which self-heals (worst case a single stale gate is lost).
const subagentDepth = new Map<string, number>();
// Sessions whose main-agent Stop fired while subagents were still in flight: the
// blocked is owed and applied when depth returns to 0 (see DEFERRED BLOCK above).
const pendingBlock = new Set<string>();

export function noteSubagentStart(claudeSessionId: string): void {
  subagentDepth.set(claudeSessionId, (subagentDepth.get(claudeSessionId) ?? 0) + 1);
}
export function noteSubagentStop(claudeSessionId: string): void {
  const next = (subagentDepth.get(claudeSessionId) ?? 0) - 1;
  if (next > 0) subagentDepth.set(claudeSessionId, next);
  else subagentDepth.delete(claudeSessionId); // floor at 0; never negative
}
export function resetSubagents(claudeSessionId: string): void {
  subagentDepth.delete(claudeSessionId);
  pendingBlock.delete(claudeSessionId);
}
function subagentsActive(claudeSessionId: string): boolean {
  return (subagentDepth.get(claudeSessionId) ?? 0) > 0;
}

// Stop edge: blocked the card ONLY when no subagent is in flight. While a
// background subagent workflow runs, the main agent's Stop is a turn-end, not a
// wait-on-you, so the card must stay in-progress — but the blocked is OWED, so we
// remember it and settle it when the last subagent stops.
export async function applyStop(host: Host, claudeSessionId: string): Promise<void> {
  if (subagentsActive(claudeSessionId)) {
    pendingBlock.add(claudeSessionId); // background turn-end; settle when depth hits 0
    return;
  }
  await applyState(host, claudeSessionId, "blocked");
}

// Called after each SubagentStop: once the last subagent finishes, apply any
// blocked that was deferred while it ran. A no-op unless a Stop is owed AND no
// subagents remain (foreground subagents leave nothing pending — their Stop
// comes later and blocks directly).
export async function settleSubagents(host: Host, claudeSessionId: string): Promise<void> {
  if (subagentsActive(claudeSessionId)) return;
  if (!pendingBlock.delete(claudeSessionId)) return;
  await applyState(host, claudeSessionId, "blocked");
}

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
    let payload: { session_id?: string; notification_type?: string; hook_event_name?: string } = {};
    try {
      payload = JSON.parse(body || "{}");
    } catch {
      /* malformed payload — no-op */
    }
    const sessionId = payload.session_id;

    // SubagentStart/SubagentStop only adjust the in-flight counter; they are not
    // a card state on their own (a launch implies in-progress, which the start
    // edge also writes). Both carry the parent session_id.
    if (url.pathname.endsWith("/session-subagent")) {
      const delta = url.searchParams.get("delta");
      if (sessionId && delta === "start") {
        noteSubagentStart(sessionId);
        await applyState(host, sessionId, "in-progress"); // launching => working
      } else if (sessionId && delta === "stop") {
        noteSubagentStop(sessionId);
        await settleSubagents(host, sessionId); // apply a Stop deferred during the run
      }
      ok();
      return;
    }

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

    // Plugin-driven transition (opencode kanban plugin): the payload carries
    // orden_session_id, so we can look up the session directly without mapping
    // through conversationId. The plugin also sends the opencode session id
    // on session.created so we can persist the mapping for the poller.
    const ordenSessionId = (payload as Record<string, unknown>).orden_session_id as
      | string
      | undefined;
    if (ordenSessionId) {
      await applyStateBySessionId(host, ordenSessionId, state, sessionId);
      ok();
      return;
    }

    if (sessionId) {
      if (state === "blocked") {
        // Stop edge — gated on in-flight subagents (see applyStop).
        await applyStop(host, sessionId);
      } else {
        // A fresh user turn (UserPromptSubmit) clears any stale subagent depth so
        // a missed SubagentStop can't gate Stop forever.
        if (payload.hook_event_name === "UserPromptSubmit") resetSubagents(sessionId);
        await applyState(host, sessionId, state);
      }
    }
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
  // Any state hook is a sign of life — stamp it so the idle reconciler (the
  // safety net for missed Stop edges) doesn't block a card whose agent is plainly
  // active. Keyed by conversationId, which for claude IS the hook's session_id.
  noteHookActivity(claudeSessionId);
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

// Plugin-driven transition: the opencode kanban plugin passes the orden session
// ID directly (via orden_session_id), so we don't need the conversationId lookup.
// On the first event (session.created) the plugin also hands us the opencode
// session id — persist it as conversationId so the poller (and future reattach)
// can use it immediately instead of waiting for discovery.
export async function applyStateBySessionId(
  host: Host,
  ordenSessionId: string,
  state: string,
  opencodeSessionId?: string,
): Promise<void> {
  // opencode writes no claude transcript, so the reconciler leans on this hook
  // stamp for liveness. Key by the opencode session id (== the persisted
  // conversationId the sweep reads).
  if (opencodeSessionId) noteHookActivity(opencodeSessionId);
  if (opencodeSessionId) {
    const ses = await host.vault.get<{ conversationId?: string; [k: string]: unknown }>(
      "sessions",
      ordenSessionId,
    );
    if (ses && !ses.conversationId) {
      await host.vault.set("sessions", ordenSessionId, { ...ses, conversationId: opencodeSessionId });
    }
  }
  const card = await cardForSession(host.vault, ordenSessionId);
  if (!card) return;
  if (card.state === "complete") return;
  if (card.state !== state) {
    await host.vault.set("cards", card.id, { ...card, state });
  }
}
