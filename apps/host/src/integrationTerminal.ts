// The merge coordinator's terminal step: what happens to a green integration
// branch once the queue drains, per the project's integrationMode.
//
//   fast     -> fast-forward the project's LOCAL main to the integration tip,
//               rebuild the web bundle, and record a pending-push count.
//               origin/main is NEVER pushed automatically (the one irreversible
//               outward step — a gated manual action).
//   measured -> push the integration branch + open a PR, never touching main.
//
// All side effects (git, rebuild, publish) are injected so the switch is
// unit-tested without a real repo or build.

import type { VaultStore } from "@orden/host-api";
import { defaultGitExec, type GitExec } from "./worktrees";
import { INTEGRATION_BRANCH } from "./integrationBranch";
import type { TerminalContext } from "./mergeCoordinator";

// Per-project integration status the web surfaces (pending-push indicator).
export const MERGE_STATUS_NS = "merge-status";

export interface MergeStatusRec {
  base: string;
  pendingPush: number; // local commits on base not yet on origin
  lastMergedCardIds: string[];
  lastMode: "fast" | "measured";
  prUrl?: string;
}

export type RebuildRunner = (repo: string) => Promise<{ code: number; output: string }>;
// Push + open a PR for the integration branch (wired to publishWorktree in serve.ts).
export type MeasuredPublish = (ctx: TerminalContext) => Promise<{ prUrl?: string }>;

export interface TerminalDeps {
  vault: VaultStore;
  rebuild: RebuildRunner;
  publish: MeasuredPublish;
  exec?: GitExec;
}

async function countPendingPush(
  repo: string,
  base: string,
  exec: GitExec,
): Promise<number> {
  // local commits on base ahead of origin/base; 0 (and no error surfaced) when
  // there is no origin remote.
  const { stdout, code } = await exec(repo, ["rev-list", "--count", `origin/${base}..${base}`]);
  if (code !== 0) return 0;
  const n = parseInt(stdout.trim(), 10);
  return Number.isFinite(n) ? n : 0;
}

export function makeTerminalStep(deps: TerminalDeps): (ctx: TerminalContext) => Promise<void> {
  const exec = deps.exec ?? defaultGitExec;
  return async (ctx) => {
    if (ctx.mode === "fast") {
      // Fast-forward the project's main checkout to the integration tip. The
      // integration branch was built off main + merges, so it is strictly ahead
      // → --ff-only succeeds (and refuses, rather than diverging, if it can't).
      await exec(ctx.plan.repo, ["merge", "--ff-only", INTEGRATION_BRANCH]);
      await deps.rebuild(ctx.plan.repo);
      const pendingPush = await countPendingPush(ctx.plan.repo, ctx.plan.base, exec);
      const rec: MergeStatusRec = {
        base: ctx.plan.base,
        pendingPush,
        lastMergedCardIds: ctx.mergedCardIds,
        lastMode: "fast",
      };
      await deps.vault.set(MERGE_STATUS_NS, ctx.projectId, rec);
    } else {
      const { prUrl } = await deps.publish(ctx);
      const rec: MergeStatusRec = {
        base: ctx.plan.base,
        pendingPush: 0,
        lastMergedCardIds: ctx.mergedCardIds,
        lastMode: "measured",
        prUrl,
      };
      await deps.vault.set(MERGE_STATUS_NS, ctx.projectId, rec);
    }
  };
}
