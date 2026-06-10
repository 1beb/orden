# Session worktree isolation: stop agents sharing the main checkout

Design settled in discussion on 2026-06-10, motivated by the 2026-06-09 incident:
four completed sessions' uncommitted work in the shared orden checkout was wiped by a
`git reset --hard` run by a concurrent session at 22:57. The work was recovered only
because opencode keeps working-tree snapshots. The structural flaw: every session of a
project runs in the same directory, so any session can destroy any other session's
(and the user's) uncommitted state, and none of it is recoverable through git because
nothing is committed until a human intervenes.

Instructions ("don't reset", "commit your work") are the weakest layer — the incident
happened in a repo whose AGENTS.md already says plenty. The fix is structural, enforced
by the host, with instructions only as reinforcement.

## Goal

1. A session works in its own git worktree, so no session can clobber a sibling's
   files or the user's checkout. Gated by a setting; on by default.
2. Session work leaves the system as a pushed branch and a PR where possible — never
   as dirty working-tree state, and never auto-merged to main (people rely on CI and
   their own merge process; orden must not bypass it).

## Decision 1: worktree-per-session, as a setting

When a session launches for a project whose source is local and whose path is inside a
git repository, the host creates a dedicated worktree and uses it as the session cwd:

```
git worktree add ~/.orden/worktrees/<projectId>/<sessionId> -b orden/<slug> <base-ref>
```

Mechanics:

- The single choke point is `resolveSessionCwd` (`apps/host/src/terminal.ts`), used by
  both launch paths (`launchDetached` and `handle`), so the session, its opencode
  session discovery, and its title polling all agree on the one cwd. The worktree
  decision lives there (or in a small helper it calls).
- The worktree path is stored on the session record (e.g. `workdir`) and treated as
  HOST_OWNED — merge-preserved against web `persist()` clobbers, same lesson as
  `conversationId`.
- Branch naming: sessions are usually untitled at first launch (the title poller runs
  after), so the slug comes from the card title / `initialPrompt` when the session was
  started from a card, falling back to `orden/<sessionId>` for untitled "+ new"
  sessions. Suffixed for uniqueness; never renamed after creation (rename-after-push
  is messy). Branches are cheap; one per session.
- Branch base: `git worktree add -b` defaults to the main checkout's current HEAD,
  which inherits whatever feature branch the user happens to be on. Instead the base
  ref is a setting, default = the repo's default branch (`origin/HEAD` →
  main/master), per-project overridable for the spawn-off-a-feature-branch case.
  Long-lived sessions drift from base; rebasing is the agent's/user's call, not
  automated.
- Created lazily at first launch, reused on resume. A relaunched/resumed session gets
  the same worktree and branch.
- The worktree root lives beside the vault and follows the same env override
  (`ORDEN_VAULT`-relative, not a hardcoded `~/.orden`).
- Non-git local projects and remote projects are unaffected (remote already isolates
  per host; worktree creation there is a later concern for the remote exec path).

The settings:

- A global toggle in the settings popover, vault-backed like the rest of settings:
  "Isolate sessions in git worktrees". Default on. Each project can override
  (on / off / inherit) — the orden repo itself is the motivating override case, see
  below.
- Read by the HOST at launch time. Settings coercion currently lives only in
  `apps/web/src/settings.ts`; the host needs its own read of `("settings", "app")`
  with the same defaulting (small shared helper or a host-side duplicate).
- Flipping it does not move running sessions; it applies to the next launch. Sessions
  record the cwd they actually got, so mixed populations are fine.
- When off (or the project is not a git repo), behavior is today's: the project path
  is the cwd. The destructive-git guardrail below matters most in exactly this mode.

Costs accepted:

- Each worktree needs its own dependency install (`pnpm install` etc.). The shared
  pnpm store keeps this cheap-ish but not free. The host does not auto-install; the
  agent runs what it needs, like any fresh clone.
- Clobbering becomes merge conflicts at integration time — visible and resolvable,
  which is the point.
- `panel_open` / `doc_render` / `/repo-file/` need to resolve paths inside a
  session's worktree: the worktree dir becomes a session-scoped file root (extension
  of the per-project file roots ADR, 2026-06-03). This is on the critical path, not
  polish — rendered plan/review docs, the core review loop, will live in worktrees.
  Size it as its own implementation task.
- Worktrees branch from committed state, so a session no longer sees the user's
  uncommitted WIP in the main checkout. Correct isolation, but a behavior change from
  today.
- Disk: worktrees share the object store with the main repo; the cost is the checkout
  itself. Cleanup rules below keep the population bounded.

## Decision 2: completion publishes a branch, not a merge

`card_complete` grows a publish step ahead of today's learnings flow. The principle:
committed-and-pushed is the only durable exit state for session work; merging is the
user's process, not orden's.

Layering: `cardComplete` in `packages/mcp` is vault-only by design (no Host, no
exec), and the dirty-check must run BEFORE the state flips — a reactor fires after
the write and cannot block. So publish is a capability-gated host service (the
`docRender` pattern): the MCP handler calls it when the host provides it; standalone
/ non-NodeHost completes as today with no publish.

On complete:

1. Dirty worktree: block until the agent commits, with an explicit "complete anyway"
   override in the user's completion dialog. Not a setting — the block is the safety
   property this design exists for. The completing agent is told to commit its work
   on its session branch; the publish service verifies mechanically
   (`git status --porcelain`).
2. Push: `git push -u origin <branch>` when the repo has a remote. A failed push
   (auth, network) must not hang or fail the completion — the card surfaces "push
   failed", the branch stays local.
3. PR via a forge setting, default "auto": infer the forge from the remote URL
   (github.com → `gh`, gitlab → `glab`, when the CLI is installed) and open a PR
   (title from the card, body from the session summary/plan doc link), storing the PR
   URL on the card. The setting is per-project overridable; explicit values pick a
   forge CLI or "push only". Unknown forge, missing CLI, or "push only": push and
   surface the compare URL. Without any remote, the local branch stays and the card
   surfaces "branch not pushed".
4. Never merge to main. No fast-forward, no auto-merge. CI, review, and merge order
   belong to the user's existing process.

The card carries the integration state (branch, pushed or not, PR URL). The Learnings
column already gives completed cards a post-completion surface; branch/PR status slots
into the same card detail.

Worktree cleanup: reap-on-complete removes the worktree only when the branch is pushed
(or the worktree is clean and the branch is merged). An unpushed branch with no remote
keeps its worktree until the user deals with it — disk is cheaper than lost work.

## Guardrail: deny destructive git in shared checkouts

Worktrees protect sessions from each other; they do not protect a session that is
deliberately pointed at the main checkout (setting off, non-git project dir, or the
user's own working copy). Orden already injects per-session settings into claude
sessions (`--settings`, how the card-state hooks arrive); add a PreToolUse deny for
`git reset --hard`, `git checkout -- .`, `git clean -f`, and `git stash` when the
session cwd is not an orden-created worktree. opencode gets the equivalent through its
permission config. In a worktree these commands are allowed — the blast radius is the
session's own sandbox.

Note this is a new hook SHAPE: today's injected hooks are fire-and-forget state
notifications, but a deny must synchronously parse the tool input, decide, and return
a blocking response. The hook script doesn't know whether its cwd is an orden
worktree — the host does — so the hook curls the host for a verdict. And
string-matching git commands is bypassable (`sh -c`, aliases, scripts): this is a
guardrail layered over the structural fix, not a sandbox.

## Out of scope

- Remote projects (worktree creation on the remote host).
- Auto-merging or auto-rebasing session branches.
- Sharing one worktree across multiple sessions of the same card.
- Host-run dependency installs in fresh worktrees.

## Resolved questions (2026-06-10 review)

- Dirty-at-complete: hard block with an explicit override in the completion dialog.
  Not softened by a setting.
- Branch base: a setting, default = the repo's default branch (folded into Decision 1
  mechanics above).
- The orden repo itself (the host serves the app from the main checkout, so with
  isolation on an agent's web changes no longer land in the served dist until
  merged + rebuilt): handled by the per-project override — set orden to off and
  accept shared-checkout risk, or leave it on and accept the merge + rebuild loop.
  The changed loop is correct behavior, not a bug.
- Publish layering: capability-gated host service called from the MCP completion
  path, not a reactor (folded into Decision 2 above).
- PR creation: forge setting, default auto-infer from the remote URL, per-project
  overridable (folded into Decision 2 above).
