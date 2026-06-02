// Reap-on-complete: when a kanban card enters the "complete" column, the work
// it tracked is finished, so any agent session still running for it should exit.
// Both completion paths land here because both write the card through the
// host's EmittingVault — the agent's own card_complete MCP tool, and a user
// dragging the card to Done in the web UI. Killing the session's tmux is
// idempotent (a dead session is a no-op), and a resumed session left under a
// still-complete card isn't re-killed: we remember which completions we've
// already reaped and forget them once the card leaves "complete".

import type { Host } from "@orden/host-api";
import { type CardRec, cardSessionIds } from "@orden/mcp";

/**
 * React to a card write: if the card is now complete, kill its linked agent
 * sessions (once). `reaped` carries the set of card ids whose completion we've
 * already acted on, so re-writes to an already-complete card don't kill a
 * session the user has since resumed.
 */
export async function reapCompletedCard(
  host: Host,
  cardId: string,
  reaped: Set<string>,
): Promise<void> {
  const card = await host.vault.get<CardRec>("cards", cardId);
  if (!card || card.state !== "complete") {
    reaped.delete(cardId); // gone or left Done — a future completion may reap again
    return;
  }
  if (reaped.has(cardId)) return; // already reaped this completion
  reaped.add(cardId);
  for (const sessionId of cardSessionIds(card)) {
    await host.sessions.kill(sessionId);
  }
}
