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
import {
  DEFAULT_INTEGRATION_MODE,
  DEFAULT_INTEGRATION_VERIFY,
  DEFAULT_INTEGRATION_REBUILD,
} from "./mergeTypes";

const execFileAsync = promisify(execFile);

export type GitExec = (
  cwd: string,
  args: string[],
) => Promise<{ stdout: string; code: number; stderr?: string }>;

// GIT_TERMINAL_PROMPT=0 so no git call can hang waiting for credentials on a
// headless host; a prompt becomes a non-zero exit instead. stderr is captured
// (and surfaced on failure) so callers can distinguish a transient lock
// contention (retryable) from a genuine error.
export const defaultGitExec: GitExec = async (cwd, args) => {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      timeout: 60_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return { stdout, code: 0, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return {
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
      code: typeof e.code === "number" ? e.code : 1,
    };
  }
};

export interface WorktreeSettings {
  isolation: boolean;
  baseRef: string;
  prForge: string;
  autoTrust: boolean;
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
    autoTrust: typeof s.worktreeAutoTrust === "boolean" ? s.worktreeAutoTrust : true,
  };
}

// The project override (on/off) beats the global setting; absent inherits it.
export function isolationEnabled(global: boolean, project: Project | null | undefined): boolean {
  if (typeof project?.worktreeIsolation === "boolean") return project.worktreeIsolation;
  return global;
}

export interface IntegrationSettings {
  mode: "fast" | "measured";
  /** Gate command (any shell command); "" = no semantic gate. */
  verify: string;
  /** Post-merge command run in `fast` mode; "" = none. */
  rebuild: string;
}

// Host-side read of the global integration defaults from ("settings","app").
export async function readIntegrationSettings(vault: VaultStore): Promise<IntegrationSettings> {
  const s = ((await vault.get<Record<string, unknown>>("settings", "app")) ?? {}) as Record<
    string,
    unknown
  >;
  const mode = s.integrationMode === "measured" || s.integrationMode === "fast"
    ? s.integrationMode
    : DEFAULT_INTEGRATION_MODE;
  const verify = typeof s.integrationVerify === "string" ? s.integrationVerify : DEFAULT_INTEGRATION_VERIFY;
  const rebuild = typeof s.integrationRebuild === "string" ? s.integrationRebuild : DEFAULT_INTEGRATION_REBUILD;
  return { mode, verify, rebuild };
}

// Project override beats the global integration setting; absent inherits it. A
// command override only applies when the project sets a non-undefined string
// (empty string is a valid override meaning "no command").
export function integrationFor(
  global: IntegrationSettings,
  project: Project | null | undefined,
): IntegrationSettings {
  const verify = typeof project?.integrationVerify === "string" ? project.integrationVerify : global.verify;
  const rebuild = typeof project?.integrationRebuild === "string" ? project.integrationRebuild : global.rebuild;
  return { mode: project?.integrationMode ?? global.mode, verify, rebuild };
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

// Per-repo serialization for worktree creation. `git worktree add -b` writes
// .git/config (branch upstream tracking) under an O_EXCL .git/config.lock that
// fails IMMEDIATELY (no wait) when a sibling process holds it. A burst of
// session launches — host restart re-firing pendingLaunch, reconnects, rapid
// clicks — races these adds against the repo's single shared lock, and the
// reproduced failure ("could not lock config file .git/config: File exists")
// made each loser fall back to the SHARED checkout, orphaning its history
// (claude keys transcripts by cwd path). Mirrors the integration reactor's
// single-flight-per-project pattern; keyed by repo path so distinct projects
// don't block each other.
const worktreeLocks = new Map<string, Promise<void>>();
function withWorktreeLock<T>(repo: string, work: () => Promise<T>): Promise<T> {
  const prev = worktreeLocks.get(repo) ?? Promise.resolve();
  const gated = prev.then(() => work());
  // Store a swallow-on-reject so a failing add never poisons the chain for the
  // next waiter; the caller observes the real outcome via the returned `gated`.
  worktreeLocks.set(
    repo,
    gated.then(
      () => undefined,
      () => undefined,
    ),
  );
  return gated;
}

// How many times to retry a worktree add that lost a lock race, and how long to
// back off between attempts. The serialization above eliminates races among
// orden's OWN adds; the retry covers the residual collision with an EXTERNAL git
// process (the user's, another tool's) that can still hold the lock briefly.
const WORKTREE_ADD_ATTEMPTS = 3;
const WORKTREE_ADD_BACKOFF_MS = 50;

// git's lock-contention messages go to stderr and look like:
//   "error: could not lock config file .git/config: File exists"
//   "fatal: Unable to create '/repo/.git/index.lock': File exists."
//   "fatal: cannot lock ref 'refs/heads/...': Unable to create '.../.lock': ..."
// Match the common shape so we retry ONLY these (a genuine error — bad base
// ref, disk full — must surface, not loop).
function isLockFailure(r: { stdout: string; stderr?: string }): boolean {
  const text = `${r.stdout}\n${r.stderr ?? ""}`;
  return /could not lock|unable to create '[^']*\.lock'|cannot lock ref|another git process|\.lock'?(?:: | File exists|\s*$)/i.test(
    text,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

// Run `git worktree add`, retrying briefly when it loses a lock race. Returns
// the last result (success or final failure) so the caller decides the fallback.
async function worktreeAddWithRetry(
  exec: GitExec,
  repo: string,
  args: string[],
): Promise<{ stdout: string; code: number; stderr?: string }> {
  let last: { stdout: string; code: number; stderr?: string } = { stdout: "", code: 1 };
  for (let attempt = 0; attempt < WORKTREE_ADD_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(WORKTREE_ADD_BACKOFF_MS * attempt);
    last = await exec(repo, args);
    if (last.code === 0) return last;
    if (!isLockFailure(last)) return last; // genuine failure — don't loop
  }
  return last;
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
  // Serialize per-repo (see withWorktreeLock): branch selection + the add itself
  // both run under the lock so a launch burst can't trip the .git/config.lock
  // race or double-pick a free branch name.
  return withWorktreeLock(input.repo, () => createSessionWorktree(input, exec));
}

// The worktree-creating core, run under the per-repo lock. Split out so the lock
// wraps the whole pickBranch→add sequence (a TOCTOU between picking a free
// branch and adding it would otherwise let two sessions both grab the same name).
async function createSessionWorktree(
  input: EnsureWorktreeInput,
  exec: GitExec,
): Promise<{ workdir: string; branch?: string } | null> {
  const workdir = join(worktreesRoot(input.vaultRoot), input.projectId, input.sessionId);
  if (existsSync(workdir)) return { workdir }; // a serialized sibling just made it
  const branch = await pickBranch(input.repo, input.title, input.sessionId, exec);
  const base = input.baseRefSetting || (await defaultBaseRef(input.repo, exec));
  mkdirSync(dirname(workdir), { recursive: true });
  // --no-track: orden branches are LOCAL (force-pushed at publish via `push -u`,
  // which sets up tracking itself), so `worktree add -b` has no reason to write
  // the .git/config upstream entry that races the config.lock under load.
  const r = await worktreeAddWithRetry(exec, input.repo, [
    "worktree", "add", "--no-track", workdir, "-b", branch, base,
  ]);
  if (r.code !== 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `orden: worktree add failed for session ${input.sessionId} (repo ${input.repo}, branch ${branch})` +
        (r.stderr ? `: ${String(r.stderr).split("\n")[0]}` : "") +
        `; falling back to the SHARED checkout`,
    );
    return null;
  }
  // Initialize codegraph in the worktree and run the initial index so MCP
  // codegraph tools work inside the isolated session. `init -i` both creates
  // .codegraph/ and indexes; a bare `index` on an uninitialized worktree fails
  // with "not initialized". Fire-and-forget: the index isn't needed for the
  // agent to start, and the agent can re-sync it after making changes.
  const codegraphBin = process.env.CODEGRAPH_BIN ?? "codegraph";
  spawn(codegraphBin, ["init", "-i", workdir], {
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

/**
 * Has a session's branch been merged into the main checkout's HEAD? Used by the
 * reaper to detect a LOCAL merge (the user ran `git merge orden/<slug>` in the
 * main checkout without pushing or going through the coordinator). Must run
 * against the project's main checkout — worktrees are project-dependent, so
 * HEAD there reflects the user's merge target, not the session's isolated state.
 *
 * `git merge-base --is-ancestor <branch> HEAD` exits 0 when branch is an
 * ancestor of HEAD (merged), 1 when not, other = error. Conservative on error:
 * returns false (never reap on a failed probe).
 */
export async function isBranchMerged(
  repo: string,
  branch: string,
  exec: GitExec = defaultGitExec,
): Promise<boolean> {
  const r = await exec(repo, ["merge-base", "--is-ancestor", branch, "HEAD"]);
  return r.code === 0;
}
