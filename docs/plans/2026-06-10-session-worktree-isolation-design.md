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
git worktree add ~/.orden/worktrees/<projectId>/<sessionId> -b orden/<session-slug>
```

Mechanics:

- The single choke point is `resolveSessionCwd` (`apps/host/src/terminal.ts`), used by
  both launch paths (`launchDetached` and `handle`), so the session, its opencode
  session discovery, and its title polling all agree on the one cwd. The worktree
  decision lives there (or in a small helper it calls).
- The worktree path is stored on the session record (e.g. `workdir`) and treated as
  HOST_OWNED — merge-preserved against web `persist()` clobbers, same lesson as
  `conversationId`.
- Branch naming: `orden/<session-slug>` from the session title slug, suffixed for
  uniqueness. Branches are cheap; one per session.
- Created lazily at first launch, reused on resume. A relaunched/resumed session gets
  the same worktree and branch.
- Non-git local projects and remote projects are unaffected (remote already isolates
  per host; worktree creation there is a later concern for the remote exec path).

The setting:

- One toggle in the settings popover, vault-backed like the rest of settings:
  "Isolate sessions in git worktrees". Default on.
- Read at launch time. Flipping it does not move running sessions; it applies to the
  next launch. Sessions record the cwd they actually got, so mixed populations are
  fine.
- When off (or the project is not a git repo), behavior is today's: the project path
  is the cwd. The destructive-git guardrail below matters most in exactly this mode.

Costs accepted:

- Each worktree needs its own dependency install (`pnpm install` etc.). The shared
  pnpm store keeps this cheap-ish but not free. The host does not auto-install; the
  agent runs what it needs, like any fresh clone.
- Clobbering becomes merge conflicts at integration time — visible and resolvable,
  which is the point.
- `panel_open` / `doc_render` / file-roots need to resolve paths inside a session's
  worktree: the worktree dir becomes a session-scoped file root (extension of the
  per-project file roots ADR, 2026-06-03).
- Disk: worktrees share the object store with the main repo; the cost is the checkout
  itself. Cleanup rules below keep the population bounded.

## Decision 2: completion publishes a branch, not a merge

`card_complete` grows a publish step ahead of today's learnings flow. The principle:
committed-and-pushed is the only durable exit state for session work; merging is the
user's process, not orden's.

On complete:

1. Dirty worktree: block (or loudly warn, see open question) until the agent commits.
   The completing agent is told to commit its work on its session branch — this is an
   instruction the hook/MCP layer can verify mechanically (`git status --porcelain`).
2. Push: `git push -u origin orden/<session-slug>` when the repo has a remote.
3. PR where possible: if `gh` is available and the repo has a GitHub remote, open a PR
   (title from the card, body from the session summary/plan doc link) and store the PR
   URL on the card. Without `gh`, push and surface the compare URL. Without any
   remote, the local branch stays and the card surfaces "branch not pushed".
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

## Out of scope

- Remote projects (worktree creation on the remote host).
- Auto-merging or auto-rebasing session branches.
- Sharing one worktree across multiple sessions of the same card.
- Host-run dependency installs in fresh worktrees.

## Open questions

- Hard block vs warn on dirty-at-complete: start with block + an explicit override in
  the completion dialog, soften if it annoys in practice.
- Branch base: current main at worktree creation. Long-lived sessions drift; rebasing
  is the agent's/user's call, not automated.
- The orden repo itself is a special case (the host serves the app from the main
  checkout): with isolation on, an agent's web changes no longer land in the served
  dist until merged + rebuilt — that is correct, but changes the current "ask the
  agent, reload the page" loop.
