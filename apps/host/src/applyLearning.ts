// Apply an accepted learning to the project tree: write its full proposedContent
// to its targetPath, then opportunistically commit it when the target dir is a git
// work-tree. The git shell-out is injectable so the logic is testable without a
// real repo. A non-repo dir (or any git step failing) is still a successful write —
// commit is best-effort and never throws.

import { spawnSync } from "node:child_process";
import type { ApplyLearningResult, Learning } from "@orden/host-api";

export type GitRunner = (
  cwd: string,
  args: string[],
) => { code: number; stdout: string; stderr: string };

export interface ApplyDeps {
  /** Read the learning record from the vault. */
  getLearning: (id: string) => Promise<Learning | null>;
  /** Write a project-relative file. */
  writeFile: (projectId: string, path: string, content: string) => Promise<void>;
  /** Resolve a projectId to its absolute root (undefined when it has none). */
  resolveRoot: (projectId: string) => Promise<string | undefined>;
}

const defaultGit: GitRunner = (cwd, args) => {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

export async function applyLearning(
  deps: ApplyDeps,
  learningId: string,
  git: GitRunner = defaultGit,
): Promise<ApplyLearningResult> {
  const learning = await deps.getLearning(learningId);
  if (!learning) throw new Error(`learning not found: ${learningId}`);

  const { projectId, targetPath, proposedContent, title } = learning;
  await deps.writeFile(projectId, targetPath, proposedContent);

  let committed = false;
  const root = await deps.resolveRoot(projectId);
  if (root) {
    // Detect a git work-tree, then add + commit. Any non-zero step (or no repo)
    // degrades to committed:false — the write already succeeded.
    if (git(root, ["rev-parse", "--is-inside-work-tree"]).code === 0) {
      const added = git(root, ["add", "--", targetPath]);
      if (added.code === 0) {
        const done = git(root, ["commit", "-m", `learning: ${title}`, "--", targetPath]);
        committed = done.code === 0;
      }
    }
  }

  return { written: true, committed, path: targetPath };
}
