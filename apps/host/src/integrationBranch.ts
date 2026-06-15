// Integration-branch git machinery for the merge coordinator.
//
// The coordinator drains completed session branches serially onto ONE
// host-managed worktree (orden/integration) — the Not-Rocket-Science Rule:
// test the combined post-merge state, advance only if green. `merge-tree` is a
// cheap no-checkout preview; the actual apply, the resolver agent's edits, and
// the test gate all run in this worktree because they need a real checkout.
//
// All git/process calls are injectable (GitExec / GateRunner) so tests never
// touch a real repo or run a real build. See
// docs/plans/2026-06-15-merge-coordinator-design.md.

import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { defaultGitExec, type GitExec } from "./worktrees";

export const INTEGRATION_BRANCH = "orden/integration";

export interface IntegrationInput {
  /** The project's main checkout (the worktree's parent repo). */
  repo: string;
  /** Where to materialize the integration worktree, e.g. <worktrees>/<projectId>/_integration. */
  integrationRoot: string;
  /** Ref to (re)build the integration branch from each drain, e.g. "main". */
  base: string;
}

export interface IntegrationHandle {
  workdir: string;
  branch: string;
  tip: string;
}

// Create — or reuse and hard-sync — the host-managed integration worktree off
// `base`. Each drain starts from a clean copy of the base ref so stale state
// from a prior drain can never leak in.
export async function ensureIntegrationWorktree(
  input: IntegrationInput,
  exec: GitExec = defaultGitExec,
): Promise<IntegrationHandle> {
  const { repo, integrationRoot, base } = input;
  if (!existsSync(integrationRoot)) {
    await exec(repo, ["worktree", "add", "-B", INTEGRATION_BRANCH, integrationRoot, base]);
  } else {
    await exec(integrationRoot, ["reset", "--hard", base]);
    await exec(integrationRoot, ["clean", "-fdq"]);
  }
  const tip = (await exec(integrationRoot, ["rev-parse", "HEAD"])).stdout.trim();
  return { workdir: integrationRoot, branch: INTEGRATION_BRANCH, tip };
}

export interface MergePreview {
  clean: boolean;
  conflictFiles: string[];
}

// Cheap conflict pre-check with no working-tree mutation. With --name-only the
// first output line is the merged tree OID; on conflict (exit != 0) the rest are
// the conflicted paths.
export async function previewMerge(
  cwd: string,
  into: string,
  incoming: string,
  exec: GitExec = defaultGitExec,
): Promise<MergePreview> {
  const { stdout, code } = await exec(cwd, [
    "merge-tree",
    "--write-tree",
    "--name-only",
    into,
    incoming,
  ]);
  if (code === 0) return { clean: true, conflictFiles: [] };
  const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  return { clean: false, conflictFiles: lines.slice(1) };
}

// Apply a non-conflicting branch onto the integration branch (in its worktree)
// and return the new tip. --no-ff keeps each session's work as a discrete merge
// commit so attribution and reverts stay possible.
export async function applyClean(
  cwd: string,
  incoming: string,
  message: string,
  exec: GitExec = defaultGitExec,
): Promise<string> {
  await exec(cwd, ["merge", "--no-ff", "--no-edit", "-m", message, incoming]);
  return (await exec(cwd, ["rev-parse", "HEAD"])).stdout.trim();
}

// Discard whatever is on the integration worktree and return it to `priorTip`.
// `merge --abort` is best-effort (it errors when no merge is in progress); the
// caller has already decided to discard.
export async function resetIntegration(
  cwd: string,
  priorTip: string,
  exec: GitExec = defaultGitExec,
): Promise<void> {
  await exec(cwd, ["merge", "--abort"]);
  await exec(cwd, ["reset", "--hard", priorTip]);
}

// Read the current tip — used after a resolver agent commits its reconciliation.
export async function currentTip(cwd: string, exec: GitExec = defaultGitExec): Promise<string> {
  return (await exec(cwd, ["rev-parse", "HEAD"])).stdout.trim();
}

// The files a branch changed relative to `base` — used to attribute a conflict's
// files back to the already-integrated sibling cards that touched them.
export async function changedFiles(
  cwd: string,
  base: string,
  branch: string,
  exec: GitExec = defaultGitExec,
): Promise<string[]> {
  const { stdout } = await exec(cwd, ["diff", "--name-only", `${base}...${branch}`]);
  return stdout.split("\n").map((l) => l.trim()).filter(Boolean);
}

export type GateRunner = (cwd: string, command: string) => Promise<{ code: number; output: string }>;

const execFileAsync = promisify(execFile);

// Default gate: run the verify command in a login shell in the integration
// worktree. A long timeout (full typecheck+test+build) and a large buffer so a
// chatty suite can't truncate-fail.
export const defaultGateRunner: GateRunner = async (cwd, command) => {
  try {
    const { stdout, stderr } = await execFileAsync("bash", ["-lc", command], {
      cwd,
      timeout: 15 * 60_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    return { code: 0, output: `${stdout}\n${stderr}` };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof e.code === "number" ? e.code : 1,
      output: `${e.stdout ?? ""}\n${e.stderr ?? ""}`,
    };
  }
};

// Run the build/test gate on the integration worktree. Green == combined state
// verified; the only basis for a silent merge when nobody reads the code.
export async function runGate(
  cwd: string,
  command: string,
  runner: GateRunner = defaultGateRunner,
): Promise<{ green: boolean; output: string }> {
  const { code, output } = await runner(cwd, command);
  return { green: code === 0, output };
}
