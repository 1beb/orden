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
import { hasLiveBackgroundCommand } from "./backgroundCommands";
import { isDestructiveGit, DESTRUCTIVE_GIT_DENY_REASON } from "./destructiveGit";

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

// Stop edge: block the card ONLY when no subagent AND no background command is
// still working. Two distinct "the turn ended but work continues" cases:
//
//   1. A background SUBAGENT workflow: the main Stop is a turn-end, not a wait,
//      so we stay in-progress — and the blocked is OWED (settled when the last
//      subagent stops; SubagentStop fires, so we can defer it).
//   2. A run_in_background BASH command: the tool returns immediately, the turn
//      ends, and Claude auto-wakes the agent when the shell finishes — but that
//      wake fires NO catchable hook, so there is nothing to "settle" against.
//      Instead we read the live truth at every Stop (hasBgCommand → the OS
//      process tree, see backgroundCommands.ts): if a command is still running,
//      stay in-progress. The NEXT Stop (after the shell completes and the agent
//      wakes) re-checks and blocks, and the idle reconciler is the backstop. No
//      deferred bookkeeping — the process IS the durable state.
export async function applyStop(
  host: Host,
  claudeSessionId: string,
  hasBgCommand: (conversationId: string) => boolean = hasLiveBackgroundCommand,
): Promise<void> {
  if (subagentsActive(claudeSessionId)) {
    pendingBlock.add(claudeSessionId); // background turn-end; settle when depth hits 0
    return;
  }
  if (hasBgCommand(claudeSessionId)) return; // a background/foreground command is still running
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

// --- Destructive-git guardrail (worktree isolation design) ------------------
// The patterns + denial text are the SINGLE source of truth in destructiveGit.ts
// (shared verbatim with the generated opencode plugin). Re-exported here so the
// claude-side consumer + its tests keep their existing import surface.
export { isDestructiveGit };

/**
 * Decide a PreToolUse hook call: deny destructive git when the session runs in
 * a SHARED checkout (no isolated worktree). Sessions with their own worktree —
 * and sessions orden doesn't know — are allowed through ({} = no opinion).
 * Returned object is the hook's JSON response body (claude's PreToolUse
 * decision protocol).
 */
export async function preToolUseVerdict(
  host: Host,
  ordenSessionId: string,
  payload: { tool_name?: string; tool_input?: { command?: string } },
): Promise<Record<string, unknown>> {
  if (payload.tool_name !== "Bash") return {};
  const command = payload.tool_input?.command ?? "";
  if (!isDestructiveGit(command)) return {};
  const ses = await host.vault.get<{ workdir?: string }>("sessions", ordenSessionId);
  if (!ses) return {}; // not an orden-tracked session — no opinion
  if (typeof ses.workdir === "string" && ses.workdir) return {}; // own sandbox
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: DESTRUCTIVE_GIT_DENY_REASON,
    },
  };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(""));
  });
}

// Repair a session record whose conversationId was lost or went stale. Claude
// hooks carry the STABLE orden session id (settingsArg bakes it into the hook
// URL) next to claude's own session_id (== the live conversationId); if they
// disagree, the live id wins. This self-heals the record so every
// conversationId-keyed lookup — hook->card, the MCP binding, reattach/--resume —
// keeps working even after a write dropped the field. No-op when the session is
// unknown or already correct; other fields are preserved.
export async function reconcileConversationId(
  host: Host,
  ordenSessionId: string,
  conversationId: string,
): Promise<void> {
  const ses = await host.vault.get<{ conversationId?: string; [k: string]: unknown }>(
    "sessions",
    ordenSessionId,
  );
  if (!ses) return;
  if (ses.conversationId === conversationId) return;
  await host.vault.set("sessions", ordenSessionId, { ...ses, conversationId });
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

    // Claude hooks bake the stable orden session id into the URL; use it to
    // self-heal a record whose conversationId was lost or went stale BEFORE any
    // conversationId-keyed lookup below runs off it. (The opencode plugin instead
    // posts orden_session_id in the BODY and takes its dedicated path further
    // down, so this query-param branch is claude-only and leaves it untouched.)
    const reconcileId = url.searchParams.get("orden_session_id");
    if (reconcileId && sessionId) await reconcileConversationId(host, reconcileId, sessionId);

    // PreToolUse guardrail: unlike every other hook (fire-and-forget), the
    // response body IS the decision — the hook command echoes it back to
    // claude. Deny only destructive git in a shared checkout.
    if (url.pathname.endsWith("/pretooluse")) {
      const verdict = reconcileId
        ? await preToolUseVerdict(
            host,
            reconcileId,
            payload as { tool_name?: string; tool_input?: { command?: string } },
          )
        : {};
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(verdict));
      return;
    }

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

// GUI (native-chat) sessions drive their card from chat-engine turn boundaries
// instead of tmux hooks — they have no PTY pane, so the claude `--settings`
// lifecycle hooks never fire (see Task 13). The chat engine knows only its OWN
// chat session id; the web's chatMount persists `chat-link: ordenSessionId ->
// chatSessionId`, so we reverse that map to recover the orden session id, then
// reuse the existing card-state setter (which honors the never-clobber-complete
// rule). A mirrored terminal session keys chat:<panelId> directly, so its chat
// id IS the orden session id; the reverse lookup falls through to that identity.
// turn "start" => in-progress (working); turn "end" => blocked (done/waiting).
async function ordenSessionForChat(host: Host, chatSessionId: string): Promise<string> {
  for (const key of await host.vault.list("chat-link")) {
    const linked = await host.vault.get<string>("chat-link", key);
    if (linked === chatSessionId) return key; // key == ordenSessionId
  }
  return chatSessionId; // mirror case (chat id == orden id) or unlinked
}

export async function applyChatTurnBoundary(
  host: Host,
  chatSessionId: string,
  edge: "start" | "end",
): Promise<void> {
  const ordenSessionId = await ordenSessionForChat(host, chatSessionId);
  const state = edge === "start" ? "in-progress" : "blocked";
  // Reuse the by-session-id setter: it resolves the card and refuses to touch a
  // "complete" card, so a GUI turn can never knock a completed card off complete.
  await applyStateBySessionId(host, ordenSessionId, state);
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
