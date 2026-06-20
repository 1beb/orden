// Reap-on-complete: when a kanban card enters the "complete" column, the work
// it tracked is finished, so any agent session still running for it should exit.
// Both completion paths land here because both write the card through the
// host's EmittingVault — the agent's own card_complete MCP tool, and a user
// dragging the card to Done in the web UI. Killing the session's tmux is
// idempotent (a dead session is a no-op), and a resumed session left under a
// still-complete card isn't re-killed: we remember which completions we've
// already reaped and forget them once the card leaves "complete".
//
// Worktree cleanup rides the same reactor. A completed card's worktree is
// removed when ANY of these hold:
//   - published: publishState ∈ {pushed, pr-opened} (the publish gate pushed it)
//   - integrated: mergeStatus === "merged" (the merge coordinator merged it)
//   - locally-merged: the branch is an ancestor of the main checkout's HEAD
//     (the user merged it locally without pushing or using the coordinator —
//     the local-merge workflow that set neither publishState nor mergeStatus)
//   - stale: the card was completed > STALENESS_MS ago and the worktree is
//     still unpushed/unmerged (likely abandoned; the branch survives the reap,
//     only the working directory goes)
// An unpushed, unmerged, fresh worktree is kept: disk is cheaper than lost work.

import { existsSync } from "node:fs";
import type { Host, Project } from "@orden/host-api";
import { type CardRec, cardSessionIds } from "@orden/mcp";
import { isOrdenWorktree, removeSessionWorktree, isBranchMerged, type GitExec } from "./worktrees";

const PUSHED_STATES = new Set(["pushed", "pr-opened"]);

// How long after completion to keep an unpushed, unmerged worktree before
// reaping it as abandoned. Conservative: a slow local-review cycle shouldn't
// lose its working directory. The branch and its commits survive the reap
// (only the worktree directory is removed); `git worktree remove` also refuses
// a dirty worktree, so uncommitted changes are never silently discarded.
const STALENESS_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

/**
 * React to a card write: if the card is now complete, kill its linked agent
 * sessions (once), then remove any reaped worktrees (idempotently). `reaped`
 * carries the set of card ids whose completion we've already acted on, so
 * re-writes to an already-complete card don't kill a session the user has
 * since resumed.
 */
export async function reapCompletedCard(
  host: Host,
  cardId: string,
  reaped: Set<string>,
  opts?: { exec?: GitExec; now?: number },
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

  // Cleanup pass: decide per-session whether its worktree is safe to remove.
  const published = typeof card.publishState === "string" && PUSHED_STATES.has(card.publishState);
  const integrated = card.mergeStatus === "merged";
  const now = opts?.now ?? Date.now();
  const stale =
    typeof card.completedAt === "number" && now - card.completedAt > STALENESS_MS;

  const vaultRoot = host.capabilities().vaultRoot;
  if (!vaultRoot) return;
  const exec = opts?.exec;
  for (const sessionId of cardSessionIds(card)) {
    const ses = await host.vault.get<{ workdir?: string; branch?: string; projectId?: string }>(
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
    const repo = project.source.path;

    // Published or coordinator-integrated → reap (existing behavior).
    if (published || integrated) {
      await removeSessionWorktree(repo, workdir, vaultRoot, exec);
      continue;
    }
    // Local-merge: the user merged the branch into the main checkout's HEAD
    // manually (the local-merge workflow). Neither publishState nor
    // mergeStatus reflects this, so without this check the worktree orphans.
    if (typeof ses.branch === "string" && ses.branch) {
      const merged = await isBranchMerged(repo, ses.branch, exec);
      if (merged) {
        await removeSessionWorktree(repo, workdir, vaultRoot, exec);
        continue;
      }
    }
    // Stale: completed long ago, unpushed, unmerged, not locally merged →
    // reap as abandoned. The branch survives; only the worktree directory goes.
    if (stale) {
      await removeSessionWorktree(repo, workdir, vaultRoot, exec);
      continue;
    }
    // Unpushed, unmerged, fresh → keep (the existing "disk < lost work" default).
  }
}
