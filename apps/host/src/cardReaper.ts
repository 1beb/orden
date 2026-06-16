// Reap-on-complete: when a kanban card enters the "complete" column, the work
// it tracked is finished, so any agent session still running for it should exit.
// Both completion paths land here because both write the card through the
// host's EmittingVault — the agent's own card_complete MCP tool, and a user
// dragging the card to Done in the web UI. Killing the session's tmux is
// idempotent (a dead session is a no-op), and a resumed session left under a
// still-complete card isn't re-killed: we remember which completions we've
// already reaped and forget them once the card leaves "complete".
//
// Worktree cleanup rides the same reactor: once a completed card's branch is
// safely pushed (publishState pushed/pr-opened), each linked session's worktree
// is removed. This pass is deliberately OUTSIDE the once-per-completion memo —
// the publish stamp often lands on a LATER card write than the completion
// itself (the web-drag path publishes via its own reactor) — and stays
// idempotent by skipping worktrees that no longer exist on disk. An unpushed
// branch keeps its worktree: disk is cheaper than lost work.

import { existsSync } from "node:fs";
import type { Host, Project } from "@orden/host-api";
import { type CardRec, cardSessionIds } from "@orden/mcp";
import { isOrdenWorktree, removeSessionWorktree, type GitExec } from "./worktrees";

const PUSHED_STATES = new Set(["pushed", "pr-opened"]);

/**
 * React to a card write: if the card is now complete, kill its linked agent
 * sessions (once), then remove any pushed worktrees (idempotently). `reaped`
 * carries the set of card ids whose completion we've already acted on, so
 * re-writes to an already-complete card don't kill a session the user has
 * since resumed.
 */
export async function reapCompletedCard(
  host: Host,
  cardId: string,
  reaped: Set<string>,
  opts?: { exec?: GitExec },
): Promise<void> {
  const card = await host.vault.get<CardRec>("cards", cardId);
  if (!card || card.state !== "complete") {
    reaped.delete(cardId); // gone or left Done — a future completion may reap again
    return;
  }
  if (!reaped.has(cardId)) {
    reaped.add(cardId);
    for (const sessionId of cardSessionIds(card)) {
      await host.sessions.kill(sessionId);
    }
  }

  // Cleanup pass: only when the branch left the system — pushed/PR'd by the
  // publish gate, or integrated by the merge coordinator (mergeStatus "merged").
  const published = typeof card.publishState === "string" && PUSHED_STATES.has(card.publishState);
  const integrated = card.mergeStatus === "merged";
  if (!published && !integrated) return;
  const vaultRoot = host.capabilities().vaultRoot;
  if (!vaultRoot) return;
  for (const sessionId of cardSessionIds(card)) {
    const ses = await host.vault.get<{ workdir?: string; projectId?: string }>(
      "sessions",
      sessionId,
    );
    const workdir = ses?.workdir;
    if (typeof workdir !== "string" || !workdir) continue;
    if (!isOrdenWorktree(workdir, vaultRoot) || !existsSync(workdir)) continue;
    // `git worktree remove` must run against the main checkout the worktree
    // belongs to — the session's project path.
    if (!ses?.projectId) continue;
    const project = await host.vault.get<Project>("projects", ses.projectId);
    if (!project || project.source.kind !== "local") continue;
    await removeSessionWorktree(project.source.path, workdir, vaultRoot, opts?.exec);
  }
}
