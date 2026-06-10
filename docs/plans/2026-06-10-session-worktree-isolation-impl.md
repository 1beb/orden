# Session Worktree Isolation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Sessions run in per-session git worktrees (setting-gated, default on); completion verifies committed work and publishes a pushed branch + PR; destructive git is denied in shared checkouts.

**Architecture:** The worktree decision lives in `resolveSessionCwd` (the single cwd choke point for both launch paths). The worktree path is persisted on the session record as host-owned `workdir`. All session-scoped file access reuses the existing `ProjectRootResolver` by teaching it a `session:<id>` pseudo-project id. Publish is a capability-gated optional `Host.publish` (the `Host.render` pattern), called from the MCP `card_complete` path before the state flips, and from a serve.ts reactor for the web drag-to-Done path. The guardrail is a new synchronous PreToolUse hook that asks the host for a verdict.

**Tech Stack:** TypeScript pnpm workspace, vitest, node `execFile` (injectable in tests), tmux/node-pty launch path (unchanged).

**Design doc:** `docs/plans/2026-06-10-session-worktree-isolation-design.md`

**Out of scope (from design):** remote projects, auto-merge/rebase, shared worktrees per card, host-run dependency installs. Additionally: GUI (native chat / SDK) sessions keep today's cwd — isolation covers tmux terminal sessions, where the incident class lives.

**Conventions for every task:** run from repo root; after each task run `pnpm -r typecheck` plus the named test command; commit only the files the task names (never `git add .`), push immediately. The repo has an unrelated dirty file `apps/web/src/chatMarkdown.ts` — NEVER stage or revert it.

---

### Task 1: Web settings — three new fields

**Files:**
- Modify: `apps/web/src/settings.ts`
- Test: `apps/web/test/settings.test.ts`

**Step 1: Write failing tests** — in the existing coerce describe block, add:

```typescript
it("defaults worktree isolation fields", () => {
  const s = coerce({});
  expect(s.worktreeIsolation).toBe(true);
  expect(s.worktreeBaseRef).toBe("");
  expect(s.prForge).toBe("auto");
});

it("keeps valid worktree fields and rejects junk", () => {
  expect(coerce({ worktreeIsolation: false }).worktreeIsolation).toBe(false);
  expect(coerce({ worktreeBaseRef: "origin/develop" }).worktreeBaseRef).toBe("origin/develop");
  expect(coerce({ prForge: "glab" }).prForge).toBe("glab");
  expect(coerce({ prForge: "hg" }).prForge).toBe("auto");
  expect(coerce({ worktreeBaseRef: 42 }).worktreeBaseRef).toBe("");
});
```

**Step 2:** `pnpm --filter @orden/web exec vitest run test/settings.test.ts` — expect FAIL (unknown fields).

**Step 3: Implement.** In `Settings` add:

```typescript
  worktreeIsolation: boolean; // launch agent sessions in per-session git worktrees
  worktreeBaseRef: string; // branch base ref; "" = the repo's default branch (origin/HEAD)
  prForge: PrForge; // PR creation on card completion: auto-infer from remote, force a CLI, or push-only
```

Add `export type PrForge = "auto" | "gh" | "glab" | "none";` and `const PR_FORGES: readonly PrForge[] = ["auto", "gh", "glab", "none"];`. DEFAULT_SETTINGS gains `worktreeIsolation: true, worktreeBaseRef: "", prForge: "auto"`. In `coerce()`:

```typescript
    worktreeIsolation:
      typeof s.worktreeIsolation === "boolean" ? s.worktreeIsolation : DEFAULT_SETTINGS.worktreeIsolation,
    worktreeBaseRef:
      typeof s.worktreeBaseRef === "string" ? s.worktreeBaseRef : DEFAULT_SETTINGS.worktreeBaseRef,
    prForge: (PR_FORGES as readonly string[]).includes(s.prForge as string)
      ? (s.prForge as PrForge)
      : DEFAULT_SETTINGS.prForge,
```

**Step 4:** test passes. **Step 5:** Commit `web: worktree isolation settings fields`.

---

### Task 2: Settings popover UI

**Files:**
- Modify: `apps/web/src/main.ts` (settings popover section — find it via the `sessionAutoLaunch` toggle)

**Step 1:** Locate the existing `sessionAutoLaunch` checkbox row in the popover builder in `main.ts`. Clone its pattern for a checkbox "Isolate sessions in git worktrees" bound to `worktreeIsolation`, and a select "PRs on completion" bound to `prForge` with options auto/gh/glab/push only (mirror an existing select like startup view). Skip a UI for `worktreeBaseRef` (settable via vault; YAGNI for the popover).

**Step 2:** `pnpm -r typecheck`, then `pnpm --filter @orden/web exec vitest run` (popover has no dedicated test; the suite guards regressions).

**Step 3:** Commit `web: settings popover worktree + PR forge controls`.

---

### Task 3: Project-level isolation override

**Files:**
- Modify: `packages/host-api/src/index.ts` (`Project`)
- Modify: `apps/web/src/projectPage.ts` (override control)
- Test: `apps/web/test/projects.test.ts` (only if it covers project fields; otherwise typecheck suffices)

**Step 1:** In `Project` add:

```typescript
  /** Per-project worktree isolation override. Absent = inherit the global setting. */
  worktreeIsolation?: boolean;
```

**Step 2:** On the project page, next to the existing per-project controls (`defaultAgent` is the pattern), add a three-way select "Session isolation": inherit (deletes the field) / on / off, persisted through the same project write path the page already uses.

**Step 3:** `pnpm -r typecheck && pnpm --filter @orden/web test`. Commit `project-level worktree isolation override`.

---

### Task 4: Host-side worktree module (settings read, slug, base ref, branch, create)

**Files:**
- Create: `apps/host/src/worktrees.ts`
- Test: `apps/host/test/worktrees.test.ts`

This is the core. Everything shelling out takes an injectable `exec` (the `RenderRunner` pattern from docRender.ts).

**Step 1: Write failing tests** covering: `readWorktreeSettings` defaults (empty vault → `{isolation: true, baseRef: "", prForge: "auto"}`) and explicit off; `isolationEnabled` (global on + project off → false; global off + project on → true; both absent → true); `slugify("Fix the /repo-file route!!")` → `"fix-the-repo-file-route"`, truncation to 40 chars, empty → `""`; `pickBranch` returns `orden/<slug>` when free, suffixes `-2` when taken (fake exec answering `rev-parse --verify`), falls back to `orden/<sessionId>` for empty slug; `defaultBaseRef` returns `origin/main` from a fake `symbolic-ref` answer and `"HEAD"` when it fails; `ensureSessionWorktree` issues `git -C <repo> worktree add <path> -b <branch> <base>` with the expected path under the worktree root and returns `{workdir, branch}`; reuse: a rec with existing `workdir` (dir exists) returns it without exec calls.

**Step 2:** run `pnpm --filter @orden/host exec vitest run test/worktrees.test.ts` — FAIL (module missing).

**Step 3: Implement** `apps/host/src/worktrees.ts`:

```typescript
// Per-session git worktree isolation (design: docs/plans/2026-06-10-session-worktree-isolation-design.md).
// A session of a local git project gets its own worktree + orden/<slug> branch so
// no session can clobber a sibling's (or the user's) uncommitted state. All git
// calls go through an injectable exec so the logic is unit-testable.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import type { VaultStore, Project } from "@orden/host-api";

const execFileAsync = promisify(execFile);
export type GitExec = (cwd: string, args: string[]) => Promise<{ stdout: string; code: number }>;
export const defaultGitExec: GitExec = async (cwd, args) => {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd });
    return { stdout, code: 0 };
  } catch (err) {
    const e = err as { code?: number; stdout?: string };
    return { stdout: e.stdout ?? "", code: typeof e.code === "number" ? e.code : 1 };
  }
};

export interface WorktreeSettings { isolation: boolean; baseRef: string; prForge: string }

// Host-side read of the web's ("settings","app") record. The web owns the full
// coerce (apps/web/src/settings.ts); here we default just the fields we need.
export async function readWorktreeSettings(vault: VaultStore): Promise<WorktreeSettings> {
  const s = ((await vault.get<Record<string, unknown>>("settings", "app")) ?? {}) as Record<string, unknown>;
  return {
    isolation: typeof s.worktreeIsolation === "boolean" ? s.worktreeIsolation : true,
    baseRef: typeof s.worktreeBaseRef === "string" ? s.worktreeBaseRef : "",
    prForge: typeof s.prForge === "string" ? s.prForge : "auto",
  };
}

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
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
}

// The repo's default branch as a base ref: origin/HEAD when set, else HEAD.
export async function defaultBaseRef(repo: string, exec: GitExec = defaultGitExec): Promise<string> {
  const r = await exec(repo, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : "HEAD";
}

export async function pickBranch(
  repo: string, title: string | undefined, sessionId: string, exec: GitExec = defaultGitExec,
): Promise<string> {
  const slug = slugify(title ?? "");
  const base = slug ? `orden/${slug}` : `orden/${sessionId}`;
  for (let i = 0; i < 20; i++) {
    const name = i === 0 ? base : `${base}-${i + 1}`;
    const r = await exec(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`]);
    if (r.code !== 0) return name; // branch doesn't exist — free
  }
  return `orden/${sessionId}`; // pathological collision space — the id is always unique
}

export async function isGitRepo(path: string, exec: GitExec = defaultGitExec): Promise<boolean> {
  const r = await exec(path, ["rev-parse", "--is-inside-work-tree"]);
  return r.code === 0 && r.stdout.trim() === "true";
}

export interface EnsureWorktreeInput {
  repo: string; // the project's local path (main checkout)
  vaultRoot: string;
  projectId: string;
  sessionId: string;
  title?: string; // card title / initialPrompt for the branch slug
  existingWorkdir?: string; // rec.workdir — reuse on resume
  baseRefSetting: string; // "" = default branch
}

export async function ensureSessionWorktree(
  input: EnsureWorktreeInput, exec: GitExec = defaultGitExec,
): Promise<{ workdir: string; branch?: string } | null> {
  if (input.existingWorkdir && existsSync(input.existingWorkdir)) {
    return { workdir: input.existingWorkdir };
  }
  if (!(await isGitRepo(input.repo, exec))) return null; // non-git project: no isolation
  const workdir = join(worktreesRoot(input.vaultRoot), input.projectId, input.sessionId);
  if (existsSync(workdir)) return { workdir }; // crash between create and persist
  const branch = await pickBranch(input.repo, input.title, input.sessionId, exec);
  const base = input.baseRefSetting || (await defaultBaseRef(input.repo, exec));
  mkdirSync(dirname(workdir), { recursive: true });
  const r = await exec(input.repo, ["worktree", "add", workdir, "-b", branch, base]);
  if (r.code !== 0) return null; // creation failed: fall back to the shared checkout
  return { workdir, branch };
}
```

**Step 4:** tests pass. **Step 5:** Commit `host: worktree creation module` (worktrees.ts + test).

---

### Task 5: Wire the worktree into `resolveSessionCwd`

**Files:**
- Modify: `apps/host/src/terminal.ts`
- Test: `apps/host/test/terminal.test.ts` (extend existing resolveSessionCwd coverage)

**Step 1: Failing tests.** Check `terminal.test.ts` for how resolveSessionCwd is currently driven (fake Host over a map vault). Add cases: (a) local git project + isolation on → returns a path under `worktreesRoot(vaultRoot)` and persists `workdir`/`branch` on the session record; (b) isolation globally off → project path; (c) project override off beats global on; (d) rec already has `workdir` → returned as-is, no creation; (e) non-git project dir → project path. Inject a fake `GitExec`; pass vaultRoot via the new options param below.

**Step 2:** run — FAIL.

**Step 3: Implement.** Change the signature (both call sites in this file pass `rec` + `sessionId` already):

```typescript
export async function resolveSessionCwd(
  host: Host,
  rec: SessionRecord,
  sessionId: string,
  defaultCwd: string,
  opts?: { exec?: GitExec }, // injectable for tests
): Promise<string>
```

Logic: resolve the project path exactly as today (non-local / missing dir → `defaultCwd`, unchanged). Then:

```typescript
  const settings = await readWorktreeSettings(host.vault);
  if (!isolationEnabled(settings.isolation, project)) return path;
  const vaultRoot = host.capabilities().vaultRoot;
  if (!vaultRoot) return path; // no persistent vault → nowhere to root worktrees
  const wt = await ensureSessionWorktree(
    {
      repo: path, vaultRoot, projectId: project.id, sessionId,
      title: rec.title && rec.title !== "Untitled session" ? rec.title : rec.initialPrompt,
      existingWorkdir: typeof rec.workdir === "string" ? rec.workdir : undefined,
      baseRefSetting: settings.baseRef,
    },
    opts?.exec,
  );
  if (!wt) return path;
  if (rec.workdir !== wt.workdir) {
    rec.workdir = wt.workdir;
    if (wt.branch) rec.branch = wt.branch;
    await host.vault.set("sessions", sessionId, rec);
  }
  return wt.workdir;
```

Add `workdir?: string; branch?: string;` to the `SessionRecord` interface in terminal.ts. Update the two call sites (`launchDetached`, `handle`) to pass `rec, sessionId`.

**Step 4:** `pnpm --filter @orden/host test` — ALL host tests pass (other suites exercise launch paths). **Step 5:** Commit `host: per-session worktree cwd in resolveSessionCwd`.

---

### Task 6: Protect `workdir`/`branch` from web persist clobbers

**Files:**
- Modify: `apps/web/src/sessions.ts` (`HOST_OWNED`, `Session` interface)
- Test: `apps/web/test/sessions.test.ts`

**Step 1:** Failing test (mirror the existing conversationId merge-preserve test): vault record has `workdir`/`branch`, cache doesn't; after `persist`-triggering call (e.g. `markSessionTouched`) the written record still carries both.

**Step 2:** FAIL. **Step 3:** `const HOST_OWNED = ["conversationId", "prompted", "workdir", "branch"] as const;` and add optional `workdir?: string; branch?: string;` to the web `Session` interface (read-only display later).

**Step 4:** pass. **Step 5:** Commit `web: workdir/branch are host-owned session fields`.

---

### Task 7: Session-scoped file roots (`session:<id>`)

**Files:**
- Modify: `apps/host/src/projectRoots.ts`
- Test: `apps/host/test/projectRoots.test.ts`

**Step 1:** Failing tests: resolver with a vault holding session `sess_1` `{workdir: "/tmp/wt"}` resolves `"session:sess_1"` → `/tmp/wt`; unknown session / session without workdir → undefined; plain project ids unchanged.

**Step 2:** FAIL. **Step 3:** In `makeProjectRootResolver`:

```typescript
    // Session-scoped root: a session running in its own worktree exposes that
    // worktree as a file root (repo-file route, FsFiles, render all resolve
    // through here), so panel_open/doc_render work on worktree paths.
    if (projectId.startsWith("session:")) {
      const rec = await host.vault.get<{ workdir?: string }>("sessions", projectId.slice(8));
      return typeof rec?.workdir === "string" ? rec.workdir : undefined;
    }
```

This automatically covers `/repo-file/session:<id>/...`, `host.files.read("session:<id>", …)`, and `host.render("session:<id>", …)` — they all take this resolver.

**Step 4:** `pnpm --filter @orden/host test`. **Step 5:** Commit `host: session-scoped file roots`.

---

### Task 8: MCP tools resolve against the session's worktree

**Files:**
- Modify: `packages/mcp/src/server.ts` (doc_render + panel_open + learning_propose root selection)
- Modify: `packages/mcp/src/tools.ts` (`panelOpen` signature gains optional projectId)
- Modify: `apps/web/src/panelIntent.ts` + `apps/web/src/main.ts` (intent carries projectId through to `openRepoFile`)
- Test: `packages/mcp/test/server.test.ts` or `tools.kanban.test.ts` pattern, `apps/web/test/panelIntent.test.ts`

**Step 1:** Failing tests: (a) mcp — with a bound session whose record has `workdir`, `doc_render` is called with project id `session:<sid>` (assert via a fake host capturing `render` args); (b) `panelOpen(vault, "doc", "report.html", "session:sess_1")` writes `{kind, target, projectId: "session:sess_1", nonce}`; (c) web — `dispatchPanelIntent({kind:"doc", target:"x.md", projectId:"session:s1"}, deps)` calls `openRepoFile` with that projectId.

**Step 2:** FAIL. **Step 3: Implement.**

- server.ts: add `async function currentRootId(): Promise<string | undefined>` — resolves the bound session; if its record has a string `workdir`, return `session:<id>`, else `session.projectId`. Use it in `doc_render` (`const pid = project ?? (await currentRootId()) ?? "repo"`), in `learning_propose`'s projectId binding for `baseContent` reads, and pass it into `tools.panelOpen` for `kind === "doc"`.
- tools.ts: `panelOpen(vault, kind, target, projectId?)` → intent record gains `projectId` when given.
- web: `PanelIntent` gains `projectId?: string`; `openRepoFile` dep signature becomes `(path: string, projectId?: string) => void`; main.ts:2118 becomes `openRepoFile: (path, pid) => void openRepoFile(pid ?? "repo", path)`.

**Step 4:** `pnpm --filter @orden/mcp test && pnpm --filter @orden/web test`. **Step 5:** Commit `mcp+web: session worktree as the doc root for render/panel intents`.

---

### Task 9: Publish module (status / push / PR)

**Files:**
- Create: `apps/host/src/publishSession.ts`
- Test: `apps/host/test/publishSession.test.ts`
- Modify: `packages/host-api/src/index.ts` (`PublishResult`, optional `Host.publish`)

**Step 1:** host-api types:

```typescript
/** Result of publishing a session worktree's branch on card completion. */
export interface PublishResult {
  state: "no-worktree" | "dirty" | "no-remote" | "pushed" | "pr-opened" | "push-failed";
  branch?: string;
  prUrl?: string;
  compareUrl?: string;
  error?: string;
}
```

and on `Host`: `publish?(sessionId: string, meta: { title: string; summary?: string }): Promise<PublishResult>;` (doc comment: capability-gated like render; absent on hosts without git/agents).

**Step 2: Failing tests** for the pure pieces with a fake `GitExec` + fake forge runner: `inferForge("git@github.com:1beb/orden.git")` → `"gh"`, `https://gitlab.com/x/y.git` → `"glab"`, other → null; `compareUrl(remote, branch)` → `https://github.com/1beb/orden/compare/<branch>?expand=1` for both ssh and https github remotes (null for unknown hosts); `publishWorktree`: dirty `status --porcelain` output → `{state:"dirty"}` and NO push attempted; clean + no remote → `no-remote`; clean + remote + push ok + forge none → `pushed` with compareUrl; push non-zero → `push-failed` with error; forge cli ok → `pr-opened` with the URL parsed from stdout.

**Step 3:** FAIL, then implement:

```typescript
// Publish a session worktree on completion: verify clean, push the branch,
// open a PR when a known forge CLI is available. NEVER merges (design decision 2).
import type { PublishResult } from "@orden/host-api";
import { defaultGitExec, type GitExec } from "./worktrees";

export type ForgeRunner = (cwd: string, cli: string, args: string[]) => Promise<{ stdout: string; code: number }>;

export function inferForge(remoteUrl: string): "gh" | "glab" | null {
  if (/github\.com[:/]/.test(remoteUrl)) return "gh";
  if (/gitlab\./.test(remoteUrl)) return "glab";
  return null;
}

export function compareUrl(remoteUrl: string, branch: string): string | null {
  const m = remoteUrl.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/);
  if (!m) return null;
  return `https://github.com/${m[1]}/${m[2]}/compare/${encodeURIComponent(branch)}?expand=1`;
}

export async function publishWorktree(
  input: { workdir: string; branch: string; title: string; summary?: string; prForge: string },
  exec: GitExec = defaultGitExec,
  forge?: ForgeRunner, // defaults to execFile with GIT_TERMINAL_PROMPT=0
): Promise<PublishResult> { /* … status → remote get-url origin → push -u origin <branch> → forge pr create … */ }
```

Implementation notes baked in: run push via exec with env `GIT_TERMINAL_PROMPT=0` and a 30s timeout so a credential prompt can't hang completion (extend `GitExec`'s default impl with an env/timeout options arg, or give publishSession its own default exec — pick the latter, simpler); `prForge: "none"` skips the CLI even when inferable; `"gh"`/`"glab"` force that CLI; PR title = card title, body = summary + plan-doc line when present; parse the PR URL as the last `https://…` token in the forge stdout.

**Step 4: NodeHost wiring.** In `nodeHost.ts` add `async publish(sessionId, meta)`: read the session record; no `workdir`/`branch` → `{state:"no-worktree"}`; else delegate to `publishWorktree` with `prForge` from `readWorktreeSettings`. (Always defined on NodeHost; BrowserHost simply lacks the method — same as `render`.)

**Step 5:** `pnpm --filter @orden/host test && pnpm -r typecheck`. Commit `host: publish-on-complete (push + PR) service`.

---

### Task 10: `card_complete` gates on dirty and publishes

**Files:**
- Modify: `packages/mcp/src/tools.ts` (`cardComplete` gains optional publish hook), `packages/mcp/src/server.ts` (force arg, host.publish pass-through), `packages/mcp/src/index.ts` (exports if needed)
- Test: `packages/mcp/test/tools.kanban.test.ts`

**Step 1: Failing tests.** Extend `cardComplete` as `cardComplete(vault, target, summary, publish?)` where `publish` is `(sessionId, meta) => Promise<PublishResult>` plus a `force` flag — signature:

```typescript
export async function cardComplete(
  vault: VaultStore,
  target: string,
  summary?: string,
  opts?: {
    force?: boolean;
    publish?: (sessionId: string, meta: { title: string; summary?: string }) => Promise<PublishResult>;
  },
): Promise<ToolResult>
```

Tests: (a) no `publish` opt → completes exactly as today (standalone path unchanged); (b) publish returns `{state:"dirty"}` and no force → result text tells the agent to commit on its branch, card state is NOT complete; (c) dirty + `force: true` → completes, card stamped `publish: {state:"dirty"}`; (d) publish `pr-opened` → completes, card carries `branch`/`prUrl`; (e) multiple linked sessions: publish called per session with a workdir, first dirty blocks.

**Step 2:** FAIL. **Step 3: Implement.** Inside `cardComplete`, before the completing write: when `opts?.publish` exists, loop `cardSessionIds(card)`, call publish for each, collect results (publish itself returns `no-worktree` for non-worktree sessions — skip those in messaging). Any `dirty` result without force → return refusal text:

```
cannot complete: session worktree has uncommitted changes on branch <branch>.
Commit your work (git add <files> && git commit) in the worktree, then call card_complete again.
Pass force:true ONLY if the user explicitly said to complete without publishing.
```

Otherwise stamp the completed card with `branch`, `prUrl`, `compareUrl`, `publishState` from the best result and include them in the success text (`card "X" -> complete (branch orden/foo pushed, PR <url>)`).

In server.ts `card_complete`: add `force: z.boolean().optional()` to the schema (description: "complete even with unpublished/dirty work — only on the user's explicit say-so") and pass `{ force, publish: host.publish?.bind(host) }`.

**Step 4:** `pnpm --filter @orden/mcp test`. **Step 5:** Commit `mcp: card_complete dirty-gate + branch/PR publish`.

---

### Task 11: Publish reactor for the web drag-to-Done path

**Files:**
- Create: `apps/host/src/publishReactor.ts`
- Modify: `apps/host/src/serve.ts` (wire it like `journalCompletedCard`)
- Test: `apps/host/test/publishReactor.test.ts`

**Step 1:** Failing tests (mirror `cardReaper.test.ts` structure): card flips to complete with a linked worktree session and no `publishState` → `host.publish` called once and the card stamped; already-stamped card → no second publish; once-set memo behaves like `reapedCards`. The web drag is the user's explicit completion (their override), so a dirty result here just stamps `publishState: "dirty"` — no blocking.

**Step 2:** FAIL → implement `publishCompletedCard(host, cardId, published: Set<string>)`, wire in serve.ts:

```typescript
// Publish-on-complete reactor: the web drag-to-Done path doesn't run the MCP
// card_complete publish gate, so publish best-effort here (never blocks — the
// drag IS the user's explicit override).
const publishedCards = new Set<string>();
host.onChange((change) => {
  if (change.ns !== "cards") return;
  void publishCompletedCard(host, change.key, publishedCards).catch(/* warn */);
});
```

**IMPORTANT ordering:** publish must run BEFORE the reaper kills sessions? No — publish reads the worktree from disk, not the live agent; order is independent. State that in a comment.

**Step 3:** `pnpm --filter @orden/host test`. Commit `host: publish reactor for web completions`.

---

### Task 12: Worktree cleanup in the reaper

**Files:**
- Modify: `apps/host/src/cardReaper.ts`, `apps/host/src/worktrees.ts` (remove helper)
- Test: `apps/host/test/cardReaper.test.ts`

**Step 1:** Failing tests: complete card, session with `workdir` under the worktrees root, card `publishState` in `{"pushed","pr-opened"}` → `git worktree remove <path>` + `git worktree prune` issued against the project repo; NOT pushed (`no-remote`/`dirty`/absent) → no removal; `worktree remove` failing (dirty) → swallowed, worktree kept.

**Step 2:** FAIL. **Step 3:** add to worktrees.ts:

```typescript
// Remove a session's worktree after its branch is safely pushed. Never --force:
// a dirty worktree fails removal and is deliberately kept (disk < lost work).
export async function removeSessionWorktree(
  repo: string, workdir: string, vaultRoot: string, exec: GitExec = defaultGitExec,
): Promise<boolean> {
  if (!isOrdenWorktree(workdir, vaultRoot)) return false; // never touch arbitrary dirs
  const r = await exec(repo, ["worktree", "remove", workdir]);
  await exec(repo, ["worktree", "prune"]);
  return r.code === 0;
}
```

In `reapCompletedCard`, after the kill loop: read each session record; when it has `workdir` + the card's `publishState` is pushed/pr-opened, resolve the project's local path and call `removeSessionWorktree` (vaultRoot from `host.capabilities().vaultRoot`; skip when absent). Reaper takes an optional injected exec for tests.

**Step 4:** tests pass. Commit `host: reap pushed worktrees on completion`.

---

### Task 13: Destructive-git guardrail (claude PreToolUse)

**Files:**
- Modify: `apps/host/src/terminal.ts` (`settingsArg` gains the PreToolUse hook), `apps/host/src/hooks.ts` (the verdict endpoint)
- Test: `apps/host/test/hooks.test.ts`, `apps/host/test/terminal.test.ts`

**Step 1: Failing tests.** hooks.ts: export `isDestructiveGit(command: string): boolean` — true for `git reset --hard`, `git reset --hard HEAD~1`, `git checkout -- .`, `git checkout .`, `git clean -f`/`-fd`/`-xdf`, `git stash`, `git stash push`; false for `git status`, `git stash list`, `git stash pop`, `git checkout -b foo`, `echo "git reset --hard"` is FINE to flag (string matching is a guardrail, accept false positives on quoted text — assert the simple behavior, document it). Endpoint test: POST `/hooks/pretooluse?orden_session_id=X` with body `{tool_name:"Bash", tool_input:{command:"git reset --hard"}}`: session X has `workdir` → response `{}`; session X without `workdir` → response carries `hookSpecificOutput.permissionDecision === "deny"`; non-Bash tool → `{}`.

**Step 2:** FAIL. **Step 3: Implement.**

hooks.ts:

```typescript
// Destructive-git guardrail (design: worktree isolation doc). String matching is
// a layered guardrail, not a sandbox — bypassable via sh -c etc.; the structural
// protection is the worktree itself.
const DESTRUCTIVE_GIT = [
  /\bgit\s+(?:[\w-]+\s+)*reset\s+(?:\S+\s+)*--hard\b/,
  /\bgit\s+(?:[\w-]+\s+)*checkout\s+(?:--\s+)?\.(?:\s|$)/,
  /\bgit\s+(?:[\w-]+\s+)*clean\s+-\w*[fdx]/,
  /\bgit\s+(?:[\w-]+\s+)*stash\b(?!\s+(?:list|show|pop|apply))/,
];
export function isDestructiveGit(command: string): boolean {
  return DESTRUCTIVE_GIT.some((re) => re.test(command));
}
```

Endpoint branch in `handleHookRequest` (before the `state` parsing, alongside `/session-subagent`): on `/pretooluse`, read `orden_session_id`, fetch the session record; deny only when the record exists, has NO `workdir`, `payload.tool_name === "Bash"` and `isDestructiveGit(payload.tool_input?.command ?? "")`; respond:

```typescript
res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason:
      "orden: destructive git is blocked in a SHARED checkout (it can wipe other sessions' and the user's uncommitted work). Commit instead, or ask the user.",
  },
}));
```

Everything else answers `{}`.

terminal.ts `settingsArg`: add a PreToolUse entry. Unlike the fire-and-forget hooks, the guard must RETURN the host's JSON to claude — so no `>/dev/null`:

```typescript
  const guard =
    `curl -sS -m 3 -X POST '<url for hooks/pretooluse?orden_session_id=…>' ` +
    `-H 'Content-Type: application/json' -d @- 2>/dev/null || true`;
  // hooks.PreToolUse = [{ matcher: "Bash", hooks: [{ type: "command", command: guard }] }]
```

Keep the existing PostToolUse state hook untouched (both can coexist; PreToolUse is a separate event).

**Step 4:** `pnpm --filter @orden/host test`. **Step 5:** Commit `host: deny destructive git outside worktrees (claude PreToolUse)`.

---### Task 14: opencode guardrail equivalent

**Files:**
- Modify: `apps/host/src/terminal.ts` (`opencodePluginSource`, `opencodeEnv`)
- Test: `apps/host/test/terminal.test.ts` (plugin source contains the hook; env carries the flag)

**Step 1:** `opencodeEnv` takes the resolved cwd's worktree status (`inWorktree: boolean`, computed in the callers from `isOrdenWorktree(cwd, vaultRoot)`) and adds `ORDEN_WORKTREE: "1"` to args/env/cmdPrefix when true. Plugin source gains:

```javascript
    "tool.execute.before": async (input, output) => {
      if (process.env.ORDEN_WORKTREE === "1") return
      if (input?.tool !== "bash") return
      const cmd = String(output?.args?.command ?? "")
      if (/git\s+(?:[\w-]+\s+)*reset\s+(?:\S+\s+)*--hard|git\s+(?:[\w-]+\s+)*checkout\s+(?:--\s+)?\.(?:\s|$)|git\s+(?:[\w-]+\s+)*clean\s+-\w*[fdx]|git\s+(?:[\w-]+\s+)*stash\b(?!\s+(list|show|pop|apply))/.test(cmd)) {
        throw new Error("orden: destructive git is blocked in a shared checkout — commit instead.")
      }
    },
```

(Throwing in `tool.execute.before` aborts the call — verify against the opencode plugin docs during implementation; if unsupported, log a warning in the plugin and leave claude-only enforcement.)

**Step 2:** typecheck + host tests. Commit `host: opencode destructive-git guard`.

---

### Task 15: Card surfaces branch / PR state

**Files:**
- Modify: `apps/web/src/cardModal.ts` (and `apps/web/src/cards.ts` `Item` type if fields need declaring)
- Test: `apps/web/test/cardModal.test.ts`

**Step 1:** Failing test: a card with `{branch: "orden/foo", prUrl: "https://github.com/x/y/pull/1", publishState: "pr-opened"}` renders a row showing the branch name and a link to the PR; `publishState: "dirty"` renders "not published — uncommitted work"; absent fields render nothing.

**Step 2:** FAIL → implement a small read-only "Integration" row in the card modal (follow the modal's existing row pattern; link opens in a new tab). Map states: `pr-opened` → PR link; `pushed` → branch + compare link; `push-failed`/`no-remote` → branch + "not pushed"; `dirty` → warning text.

**Step 3:** `pnpm --filter @orden/web test`. Commit `web: card shows session branch/PR status`.

---

### Task 16: MCP instructions + AGENTS.md

**Files:**
- Modify: `packages/mcp/src/server.ts` (INSTRUCTIONS)
- Modify: `AGENTS.md` (Architecture → agent sessions + card-state section)

**Step 1:** INSTRUCTIONS additions: sessions may run in an isolated git worktree on their own `orden/<slug>` branch; commit your work there as you go — `card_complete` verifies a clean tree, pushes the branch, and opens a PR; it will refuse on uncommitted changes (`force:true` only on the user's explicit say-so); never merge to main yourself.

**Step 2:** AGENTS.md: a short paragraph in "Agent sessions" describing worktree isolation (setting, default on, `~/.orden/worktrees/<projectId>/<sessionId>`, branch naming, publish-on-complete, the guardrail) and a pointer to the design doc.

**Step 3:** `pnpm -r typecheck && pnpm -r test`. Commit `docs+mcp: worktree isolation contract`.

---

### Task 17: Full verification

1. `pnpm -r typecheck` — clean.
2. `pnpm -r test` — 100% pass.
3. `pnpm --filter @orden/web build` — clean.
4. Manual smoke (host is normally already running; coordinate before restarting it): create a throwaway local git project, spawn a session, confirm `~/.orden/worktrees/<pid>/<sid>` exists on the expected branch and the agent's pane cwd is the worktree; flip the global setting off, new session lands in the project path; in that shared-checkout session ask the agent to run `git reset --hard` and confirm the deny; commit work in a worktree session, complete the card, confirm push + PR fields on the card.
