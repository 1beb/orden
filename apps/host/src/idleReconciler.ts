// Idle reconciler: a SAFETY NET for the hook-driven kanban cycle.
//
// Card state is normally driven by agent hooks (hooks.ts): Stop -> blocked when
// a turn ends. But that blocked transition is fragile — it's gated on in-flight
// subagents and the "owed" block is held in an in-memory Set, so a missed
// SubagentStop, or a host restart mid-turn, can leave a card stuck at
// "in-progress" forever with no edge left to move it. There is otherwise nothing
// that ever asks "is this agent actually idle?".
//
// This sweep closes that gap. Periodically (and so also shortly after boot) it
// moves any "in-progress" card whose agent has produced no output for a while to
// "blocked". The signal is the agent's LAST-ACTIVITY time, computed from the most
// reliable source available:
//   - claude: the transcript file mtime (~/.claude/projects/<cwd>/<id>.jsonl).
//     Every token + tool result the agent writes touches this file, so a stale
//     mtime means the agent isn't working. It is DURABLE across host restarts (a
//     file mtime, not in-memory state), which is exactly why it fixes the
//     restart-stuck case without a startup blanket-block that would flicker live
//     sessions.
//   - any agent: the last state-hook we saw for it (in-memory fallback, mainly
//     for opencode, which writes no claude transcript).
//   - floor: the session's own creation time (decoded from its id), so a
//     just-launched agent that hasn't written anything yet is never blocked
//     before the idle window elapses.
// We take the MAX of these — any sign of life keeps the card in-progress.
//
// Self-healing: if a still-working agent is mis-blocked (e.g. one tool ran longer
// than the window), its next PostToolUse hook flips the card back to in-progress
// (hooks.ts, the recovery edge). So a tight-ish window costs at most a brief
// flicker, never a stuck card. "complete" is terminal and never touched (we only
// ever act on cards already in "in-progress").

import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Host } from "@orden/host-api";
import { cardSessionIds, type CardRec, type SessionRec } from "@orden/mcp";
import { encodeCwd } from "./transcriptTitle";
import { resolveSessionCwd } from "./terminal";

// Default idle window before an inactive in-progress card is moved to blocked.
// Generous enough to ride out a single long-running tool turn (claude fires
// PostToolUse after each tool, so steady-state gaps are short). Tunable via env.
export const DEFAULT_IDLE_MS = 5 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 60 * 1000;

// Per-conversation last state-hook timestamp. Durable transcript mtime is the
// primary signal; this is the fallback for agents that write no claude
// transcript (opencode) and for the gap between a prompt submit and the first
// transcript write. Keyed by conversationId (the id the sweep reads off the
// session record). A long-lived module Map is fine: one host process; a restart
// drops it and the transcript mtime / creation-time floor cover the gap.
const lastHookAt = new Map<string, number>();

/** Stamp agent liveness for a conversation — called from the hook handler. */
export function noteHookActivity(conversationId: string, now: number = Date.now()): void {
  if (conversationId) lastHookAt.set(conversationId, now);
}

const claudeHome = (): string => process.env.HOME || homedir();

function transcriptMtime(cwd: string, conversationId: string): number | null {
  try {
    const f = join(claudeHome(), ".claude", "projects", encodeCwd(cwd), `${conversationId}.jsonl`);
    return statSync(f).mtimeMs;
  } catch {
    return null;
  }
}

// Session ids embed their creation time as base36 (`sess_<time36>_<n>`). Used as
// the activity floor so a brand-new agent isn't blocked before it can write.
function sessionCreatedAt(id: string): number | null {
  const part = id.split("_")[1];
  if (!part) return null;
  const ms = parseInt(part, 36);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

/** Most recent sign of life for a session, epoch ms, or null if entirely unknown. */
export function defaultLastActivity(session: SessionRec, cwd: string): number | null {
  const conv = session.conversationId;
  const candidates: number[] = [];
  if (conv) {
    const tx = transcriptMtime(cwd, conv);
    if (tx !== null) candidates.push(tx);
    const hook = lastHookAt.get(conv);
    if (hook !== undefined) candidates.push(hook);
  }
  const created = sessionCreatedAt(session.id);
  if (created !== null) candidates.push(created);
  return candidates.length ? Math.max(...candidates) : null;
}

export interface IdleDeps {
  now: () => number;
  idleMs: number;
  /** Last agent-activity epoch ms for a session, or null if unknown. Injectable for tests. */
  lastActivity: (session: SessionRec, cwd: string) => number | null;
}

/**
 * One reconcile pass. Moves every "in-progress" card whose agent has been idle
 * longer than `idleMs` to "blocked". A card is judged idle only when EVERY linked
 * session is idle (any live session keeps it in-progress). Cards with no linked
 * session, or whose activity is entirely unknown, are left untouched (we never
 * block on missing evidence). Returns the ids of cards moved.
 */
export async function reconcileIdleCards(
  host: Host,
  defaultCwd: string,
  deps: IdleDeps,
): Promise<string[]> {
  const now = deps.now();
  const moved: string[] = [];
  for (const cardId of await host.vault.list("cards")) {
    const card = await host.vault.get<CardRec>("cards", cardId);
    if (!card || card.state !== "in-progress") continue;
    const sessionIds = cardSessionIds(card);
    if (sessionIds.length === 0) continue;
    let newest: number | null = null;
    for (const sid of sessionIds) {
      const ses = await host.vault.get<SessionRec>("sessions", sid);
      if (!ses) continue;
      const cwd = await resolveSessionCwd(host, ses.projectId, defaultCwd);
      const a = deps.lastActivity(ses, cwd);
      if (a !== null && (newest === null || a > newest)) newest = a;
    }
    if (newest === null) continue; // no evidence either way — leave it
    if (now - newest > deps.idleMs) {
      await host.vault.set("cards", cardId, { ...card, state: "blocked" });
      moved.push(cardId);
    }
  }
  return moved;
}

/**
 * Start the periodic idle sweep. Returns a stop function. The interval is
 * unref'd so it never keeps the process alive. Idle window defaults to
 * DEFAULT_IDLE_MS, overridable via ORDEN_IDLE_BLOCK_MS (ms) or opts.
 */
export function startIdleReconciler(
  host: Host,
  defaultCwd: string,
  opts?: { idleMs?: number; intervalMs?: number },
): () => void {
  const envMs = Number(process.env.ORDEN_IDLE_BLOCK_MS);
  const idleMs = opts?.idleMs ?? (Number.isFinite(envMs) && envMs > 0 ? envMs : DEFAULT_IDLE_MS);
  const intervalMs = opts?.intervalMs ?? DEFAULT_INTERVAL_MS;
  const deps: IdleDeps = { now: Date.now, idleMs, lastActivity: defaultLastActivity };
  const tick = (): void => {
    void reconcileIdleCards(host, defaultCwd, deps).catch((err) => {
      // eslint-disable-next-line no-console
      console.warn("orden: idle reconcile failed:", err);
    });
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
