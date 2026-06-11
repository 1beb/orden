// Per-session git worktree isolation (design:
// docs/plans/2026-06-10-session-worktree-isolation-design.md). A session of a
// local git project gets its own worktree + orden/<slug> branch so no session
// can clobber a sibling's (or the user's) uncommitted state. All git calls go
// through an injectable exec so the logic is unit-testable without real repos.

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import type { VaultStore, Project } from "@orden/host-api";

const execFileAsync = promisify(execFile);

export type GitExec = (cwd: string, args: string[]) => Promise<{ stdout: string; code: number }>;

// GIT_TERMINAL_PROMPT=0 so no git call can hang waiting for credentials on a
// headless host; a prompt becomes a non-zero exit instead.
export const defaultGitExec: GitExec = async (cwd, args) => {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      timeout: 60_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return { stdout, code: 0 };
  } catch (err) {
    const e = err as { code?: number; stdout?: string };
    return { stdout: e.stdout ?? "", code: typeof e.code === "number" ? e.code : 1 };
  }
};

export interface WorktreeSettings {
  isolation: boolean;
  baseRef: string;
  prForge: string;
}

// Host-side read of the web's ("settings","app") record. The web owns the full
// coerce (apps/web/src/settings.ts); here we default just the fields the host
// needs at launch/publish time.
export async function readWorktreeSettings(vault: VaultStore): Promise<WorktreeSettings> {
  const s = ((await vault.get<Record<string, unknown>>("settings", "app")) ?? {}) as Record<
    string,
    unknown
  >;
  return {
    isolation: typeof s.worktreeIsolation === "boolean" ? s.worktreeIsolation : true,
    baseRef: typeof s.worktreeBaseRef === "string" ? s.worktreeBaseRef : "",
    prForge: typeof s.prForge === "string" ? s.prForge : "auto",
  };
}

// The project override (on/off) beats the global setting; absent inherits it.
export function isolationEnabled(global: boolean, project: Project | null | undefined): boolean {
  if (typeof project?.worktreeIsolation === "boolean") return project.worktreeIsolation;
  return global;
}

// Worktrees live BESIDE the vault (~/.orden/vault -> ~/.orden/worktrees) so the
// ORDEN_VAULT override relocates them too.
export function worktreesRoot(vaultRoot: string): string {
  return resolve(vaultRoot, "..", "worktrees");
}

export function isOrdenWorktree(path: string, vaultRoot: string): boolean {
  return path.startsWith(worktreesRoot(vaultRoot) + "/");
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
}

// The repo's default branch as a base ref: origin/HEAD when set, else HEAD.
// (origin/HEAD is unset on clones that never fetched it and on remoteless
// repos; HEAD keeps worktree creation working there.)
export async function defaultBaseRef(repo: string, exec: GitExec = defaultGitExec): Promise<string> {
  const r = await exec(repo, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : "HEAD";
}

// Branch for a session: orden/<slug-of-title>, suffixed for uniqueness, falling
// back to the (always unique) session id when there's no title to slug.
export async function pickBranch(
  repo: string,
  title: string | undefined,
  sessionId: string,
  exec: GitExec = defaultGitExec,
): Promise<string> {
  const slug = slugify(title ?? "");
  const base = slug ? `orden/${slug}` : `orden/${sessionId}`;
  for (let i = 0; i < 20; i++) {
    const name = i === 0 ? base : `${base}-${i + 1}`;
    const r = await exec(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`]);
    if (r.code !== 0) return name; // branch doesn't exist — free
  }
  return `orden/${sessionId}`; // pathological collision space — the id is unique
}

export async function isGitRepo(path: string, exec: GitExec = defaultGitExec): Promise<boolean> {
  const r = await exec(path, ["rev-parse", "--is-inside-work-tree"]);
  return r.code === 0 && r.stdout.trim() === "true";
}

export interface EnsureWorktreeInput {
  /** The project's local path (the main checkout). */
  repo: string;
  vaultRoot: string;
  projectId: string;
  sessionId: string;
  /** Card title / initialPrompt, for the branch slug. */
  title?: string;
  /** rec.workdir — reused on resume/relaunch. */
  existingWorkdir?: string;
  /** worktreeBaseRef setting; "" = the repo's default branch. */
  baseRefSetting: string;
}

/**
 * Ensure the session has a worktree, creating it lazily on first launch.
 * Returns null when isolation can't apply here (non-git dir, creation failed)
 * — the caller falls back to the shared checkout.
 */
export async function ensureSessionWorktree(
  input: EnsureWorktreeInput,
  exec: GitExec = defaultGitExec,
): Promise<{ workdir: string; branch?: string } | null> {
  if (input.existingWorkdir && existsSync(input.existingWorkdir)) {
    return { workdir: input.existingWorkdir };
  }
  if (!(await isGitRepo(input.repo, exec))) return null;
  const workdir = join(worktreesRoot(input.vaultRoot), input.projectId, input.sessionId);
  if (existsSync(workdir)) return { workdir }; // crash between create and persist
  const branch = await pickBranch(input.repo, input.title, input.sessionId, exec);
  const base = input.baseRefSetting || (await defaultBaseRef(input.repo, exec));
  mkdirSync(dirname(workdir), { recursive: true });
  const r = await exec(input.repo, ["worktree", "add", workdir, "-b", branch, base]);
  if (r.code !== 0) return null;
  // Build a fresh codegraph index in the worktree so MCP codegraph tools work
  // inside the isolated session. Fire-and-forget: the index isn't needed for
  // the agent to start, and the agent can re-sync it after making changes.
  const codegraphBin = process.env.CODEGRAPH_BIN ?? "codegraph";
  spawn(codegraphBin, ["index", workdir], {
    stdio: "ignore",
    detached: true,
  }).unref();
  return { workdir, branch };
}

/**
 * Remove a session's worktree after its branch is safely pushed. Never --force:
 * a dirty worktree fails removal and is deliberately kept (disk < lost work).
 * Refuses paths outside the orden worktrees root.
 */
export async function removeSessionWorktree(
  repo: string,
  workdir: string,
  vaultRoot: string,
  exec: GitExec = defaultGitExec,
): Promise<boolean> {
  if (!isOrdenWorktree(workdir, vaultRoot)) return false;
  const r = await exec(repo, ["worktree", "remove", workdir]);
  await exec(repo, ["worktree", "prune"]);
  return r.code === 0;
}
