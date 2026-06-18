// Journal-on-complete: when a kanban card enters the "complete" column, write
// its completion entry to today's journal page and the card's own log. Like the
// reaper (see cardReaper.ts), this reacts to the card write through the host's
// EmittingVault, so BOTH completion paths are covered: the agent's own
// card_complete MCP tool (which also logs directly — the duplicate is collapsed)
// and a user dragging the card to Done in the web UI (which only sets state, so
// the journal entry depends entirely on this reactor).

import type { Host } from "@orden/host-api";
import { type CardRec, logCardCompletion } from "@orden/mcp";
import { isEngineDrivenCard } from "./runbookRunner";

/**
 * React to a card write: if the card is now complete, append its completion
 * entry to the journal + card log (once). `journaled` carries the set of card
 * ids whose completion we've already logged, so re-writes to an already-complete
 * card don't append again; the id is forgotten once the card leaves "complete",
 * so a future re-completion logs afresh. logCardCompletion is itself idempotent
 * (byte-identical entries collapse), so this guard is an optimization, not the
 * sole defense. DEFERS for engine-driven cards (the runbook runner's `journal`
 * terminal step handles those); default-workflow cards behave exactly as before.
 */
export async function journalCompletedCard(
  host: Host,
  cardId: string,
  journaled: Set<string>,
): Promise<void> {
  const card = await host.vault.get<CardRec>("cards", cardId);
  if (!card || card.state !== "complete") {
    journaled.delete(cardId); // gone or left Done — a future completion logs again
    return;
  }
  if (await isEngineDrivenCard(host.vault, cardId)) return; // engine-driven: runner handles it
  if (journaled.has(cardId)) return; // already logged this completion
  journaled.add(cardId);
  await logCardCompletion(host.vault, card);
}
