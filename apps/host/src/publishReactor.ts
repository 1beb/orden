// Publish-on-complete reactor: the web drag-to-Done path writes the card state
// directly, so it never runs the MCP card_complete publish gate. This reactor
// publishes best-effort AFTER the fact — it never blocks (the drag IS the
// user's explicit completion, i.e. their override), it just pushes what's
// committed and stamps the outcome on the card. The MCP path stamps
// publishState at completion, which this skips on, so the two paths never
// double-publish. Ordering vs the reaper is independent: publish reads the
// worktree from disk, not the live agent.

import type { Host, PublishResult } from "@orden/host-api";
import { type CardRec, cardSessionIds } from "@orden/mcp";

const PUBLISH_RANK: Record<PublishResult["state"], number> = {
  clean: 6, // verified clean, awaiting coordinator integration — the success state
  "pr-opened": 5,
  pushed: 4,
  "push-failed": 3,
  "no-remote": 2,
  dirty: 1,
  "no-worktree": 0,
};

/**
 * React to a card write: when the card is complete, carries no publish stamp,
 * and the host can publish, push each linked session's worktree branch and
 * stamp the best outcome on the card. `published` memoizes handled completions
 * (cleared when the card leaves complete) so the stamp's own write — and any
 * rapid re-fires before it lands — don't re-publish.
 */
export async function publishCompletedCard(
  host: Host,
  cardId: string,
  published: Set<string>,
): Promise<void> {
  if (!host.publish) return;
  const card = await host.vault.get<CardRec>("cards", cardId);
  if (!card || card.state !== "complete") {
    published.delete(cardId); // gone or left Done — a future completion may publish again
    return;
  }
  if (published.has(cardId)) return;
  if (typeof card.publishState === "string" && card.publishState) {
    published.add(cardId); // MCP completion already published
    return;
  }
  published.add(cardId);
  const results: PublishResult[] = [];
  for (const sessionId of cardSessionIds(card)) {
    results.push(
      await host.publish(sessionId, {
        title: card.title,
        summary: typeof card.completionSummary === "string" ? card.completionSummary : undefined,
      }),
    );
  }
  const real = results.filter((r) => r.state !== "no-worktree");
  if (real.length === 0) return; // nothing isolated → nothing to stamp
  const best = real.sort((a, b) => PUBLISH_RANK[b.state] - PUBLISH_RANK[a.state])[0];
  await host.vault.set("cards", card.id, {
    ...card,
    publishState: best.state,
    ...(best.branch ? { branch: best.branch } : {}),
    ...(best.prUrl ? { prUrl: best.prUrl } : {}),
    ...(best.compareUrl ? { compareUrl: best.compareUrl } : {}),
    ...(best.error ? { publishError: best.error } : {}),
  });
}
