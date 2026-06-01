// Session titling + boot reconcile, kept free of the terminal's native deps
// (node-pty / ws) so it's directly unit-testable. These functions tail Claude
// Code's on-disk transcript (transcriptTitle.ts) to name a session from the
// agent's own self-authored title, and to rescue a prompted-but-untitled session
// from the web's reaper. No `claude -p`, no agent turn — disk reads only.

import type { Host } from "@orden/host-api";
import { readTranscriptTitle, readTranscriptSummary, readUserPrompt } from "./transcriptTitle";

interface TitleRecord {
  id: string;
  title?: string;
  conversationId?: string;
  summary?: string;
  prompted?: boolean;
  [k: string]: unknown;
}

export const UNTITLED = new Set(["", "Untitled", "Untitled session"]);

// Write a discovered title onto the session record (while still "Untitled") and
// the linked kanban card. Returns true once a title sticks (so the poller stops).
export async function persistTitle(host: Host, sessionId: string, title: string): Promise<boolean> {
  const rec = await host.vault.get<TitleRecord>("sessions", sessionId);
  if (!rec) return true; // session gone — nothing more to do
  if (!UNTITLED.has((rec.title ?? "").trim())) return true; // user/agent already named it
  rec.title = title;
  await host.vault.set("sessions", sessionId, rec);
  const cardIds = await host.vault.list("cards");
  for (const cid of cardIds) {
    const card = await host.vault.get<{
      sessionIds?: string[];
      sessionId?: string;
      [k: string]: unknown;
    }>("cards", cid);
    const linked = Array.isArray(card?.sessionIds)
      ? card!.sessionIds
      : card?.sessionId
        ? [card.sessionId]
        : [];
    if (card && linked.includes(sessionId)) {
      await host.vault.set("cards", cid, { ...card, title });
      break;
    }
  }
  return true;
}

// Capture a transcript-derived digest onto the session record once available.
// Independent of titling (a user may have renamed the session) and idempotent —
// it never overwrites an existing summary (e.g. a user edit). No `claude -p`.
export async function persistSummary(
  host: Host,
  sessionId: string,
  cwd: string,
  conversationId: string,
): Promise<void> {
  const rec = await host.vault.get<TitleRecord>("sessions", sessionId);
  if (!rec || (rec.summary ?? "").trim()) return;
  const summary = readTranscriptSummary(cwd, conversationId);
  if (!summary) return;
  rec.summary = summary;
  await host.vault.set("sessions", sessionId, rec);
}

// Boot reconcile: the title poller only runs while a /term socket is open, so a
// session the user prompted then navigated away from (within ~5s) can be left
// "Untitled" on disk even though its transcript is rich — the detached agent
// kept writing. The web's boot sweep (reapDeadSessions) would then nuke it as a
// dead stub. Here, once at host startup, we tail each still-Untitled session's
// transcript and rescue it: apply the agent's own title if present, else flag it
// `prompted` when a real human turn exists. The web reaper skips prompted/titled
// sessions, so prompted work survives a reload. Never throws — a single bad
// record must not abort the sweep, and a missing transcript is a no-op.
export async function reconcileUntitledSessions(host: Host, cwd: string): Promise<void> {
  let ids: string[];
  try {
    ids = await host.vault.list("sessions");
  } catch {
    return;
  }
  for (const id of ids) {
    try {
      const rec = await host.vault.get<TitleRecord>("sessions", id);
      if (!rec || !UNTITLED.has((rec.title ?? "").trim())) continue;
      const convId = rec.conversationId;
      if (!convId) continue; // no transcript to read yet
      const title = readTranscriptTitle(cwd, convId);
      if (title) {
        await persistSummary(host, id, cwd, convId);
        await persistTitle(host, id, title);
        continue;
      }
      // No agent title yet, but a submitted prompt means real work — protect it.
      if (!rec.prompted && readUserPrompt(cwd, convId)) {
        rec.prompted = true;
        await host.vault.set("sessions", id, rec);
      }
    } catch {
      /* one bad record must not abort the sweep */
    }
  }
}
