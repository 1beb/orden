// Publish a session worktree on card completion: verify the tree is clean,
// push its orden/<slug> branch, and open a PR when a forge CLI is available.
// NEVER merges — CI, review, and merge order belong to the user's own process
// (design decision 2, docs/plans/2026-06-10-session-worktree-isolation-design.md).
// Git + forge calls are injectable for tests.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PublishResult } from "@orden/host-api";
import { defaultGitExec, defaultBaseRef, type GitExec } from "./worktrees";

const execFileAsync = promisify(execFile);

export type ForgeRunner = (
  cwd: string,
  cli: string,
  args: string[],
) => Promise<{ stdout: string; code: number }>;

// Forge CLIs run with GIT_TERMINAL_PROMPT=0 and a hard timeout so an auth
// prompt can't hang completion; a prompt becomes a non-zero exit instead.
const defaultForgeRunner: ForgeRunner = async (cwd, cli, args) => {
  try {
    const { stdout } = await execFileAsync(cli, args, {
      cwd,
      timeout: 60_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" },
    });
    return { stdout, code: 0 };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return {
      stdout: [e.stdout, e.stderr].filter(Boolean).join("\n") || String(err),
      code: typeof e.code === "number" ? e.code : 1,
    };
  }
};

// Map a remote URL to the forge CLI that can open PRs against it.
export function inferForge(remoteUrl: string): "gh" | "glab" | null {
  if (/github\.com[:/]/.test(remoteUrl)) return "gh";
  if (/gitlab\./.test(remoteUrl)) return "glab";
  return null;
}

// A GitHub branch-compare URL — the "open a PR yourself" link surfaced when the
// push succeeded but no PR was created. Null for forges we can't template.
export function compareUrl(remoteUrl: string, branch: string): string | null {
  const m = remoteUrl.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/);
  if (!m) return null;
  return `https://github.com/${m[1]}/${m[2]}/compare/${encodeURIComponent(branch)}?expand=1`;
}

export interface PublishInput {
  workdir: string;
  branch: string;
  /** PR title (the card title). */
  title: string;
  /** PR body seed (the session/card summary). */
  summary?: string;
  /** The prForge setting: "auto" | "gh" | "glab" | "none". */
  prForge: string;
  /** Verify the tree is clean and report the branch WITHOUT pushing or opening a PR. */
  checkOnly?: boolean;
  /**
   * The worktreeBaseRef setting ("" = resolve the repo's default). Used in
   * checkOnly mode to verify the branch has commits beyond the base ref — an
   * empty branch (0 commits beyond base) means the worktree never held the
   * session's real work, which is the clean-check tautology this guards against.
   */
  baseRefSetting?: string;
}

export async function publishWorktree(
  input: PublishInput,
  exec: GitExec = defaultGitExec,
  forge: ForgeRunner = defaultForgeRunner,
): Promise<PublishResult> {
  const { workdir, branch } = input;

  const status = await exec(workdir, ["status", "--porcelain"]);
  if (status.code !== 0) {
    return { state: "push-failed", branch, error: `git status failed: ${status.stdout.trim()}` };
  }
  if (status.stdout.trim() !== "") return { state: "dirty", branch };

  // checkOnly: the merge coordinator owns the actual push/PR (ordered, combined),
  // so completion only VERIFIES the tree is clean and reports the branch. No
  // per-session push happens; the branch is integrated later by the coordinator.
  if (input.checkOnly) {
    // Guard against the clean-check tautology: the worktree is clean BECAUSE
    // the work landed in the shared checkout, not because it's committed. If
    // the branch has zero commits beyond its base ref, the agent never
    // committed anything to THIS worktree — stamp ran-in-shared so completion
    // can refuse (the work, if any, is elsewhere).
    const base = input.baseRefSetting || (await defaultBaseRef(workdir, exec));
    const rev = await exec(workdir, ["rev-list", "--count", `${base}..HEAD`]);
    if (rev.code === 0 && Number.parseInt(rev.stdout.trim(), 10) === 0) {
      return { state: "ran-in-shared", branch };
    }
    return { state: "clean", branch };
  }

  const remote = await exec(workdir, ["remote", "get-url", "origin"]);
  if (remote.code !== 0 || !remote.stdout.trim()) return { state: "no-remote", branch };
  const remoteUrl = remote.stdout.trim();

  const push = await exec(workdir, ["push", "-u", "origin", branch]);
  if (push.code !== 0) {
    return { state: "push-failed", branch, error: push.stdout.trim() || "git push failed" };
  }

  const cmp = compareUrl(remoteUrl, branch) ?? undefined;
  const cli = input.prForge === "auto" ? inferForge(remoteUrl) : input.prForge;
  if (!cli || cli === "none") return { state: "pushed", branch, compareUrl: cmp };

  // gh and glab share the `pr/mr create` shape closely enough; both print the
  // created PR/MR URL on stdout.
  const args =
    cli === "glab"
      ? ["mr", "create", "--source-branch", branch, "--title", input.title, "--description", input.summary ?? "", "--yes"]
      : ["pr", "create", "--head", branch, "--title", input.title, "--body", input.summary ?? ""];
  const pr = await forge(workdir, cli, args);
  if (pr.code !== 0) {
    // The branch IS pushed — surface the compare link plus what the CLI said.
    return { state: "pushed", branch, compareUrl: cmp, error: pr.stdout.trim() };
  }
  const url = pr.stdout.match(/https?:\/\/\S+/g)?.at(-1);
  if (!url) return { state: "pushed", branch, compareUrl: cmp };
  return { state: "pr-opened", branch, prUrl: url, compareUrl: cmp };
}
