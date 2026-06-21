# ADR-0019: The serving checkout tracks main

**Date:** 2026-06-21
**Status:** accepted

## Context

The running host serves the web bundle as static files from
`resolve(repoRoot, "apps/web/dist")` (`apps/host/src/serve.ts`) — in practice
`/home/b/projects/orden/apps/web/dist`, where the long-lived host process runs.
That directory is an ordinary git working tree, and nothing pins it to `main`.

It had drifted: on 2026-06-21 `/home/b/projects/orden` was checked out on a feature
branch (`orden/host-search-phases-2-4`), 26 commits behind `main` and predating the
on-hold lifecycle work entirely. The dist on disk happened to be a stale build, so
the live app had no on-hold concept at all — no board lane, no project-page list
group — even though that work had been merged to `main` days earlier. The bug report
that surfaced this ("where is my on-hold state?") was really "the served bundle is
built from a branch that doesn't have it."

This is a trap because the integration ritual is "merge to `main`, rebuild dist"
(sessions run in isolated worktrees; completed work fast-forwards local `main`). That
ritual silently assumes the serving checkout *is* `main`. When it isn't,
`pnpm --filter @orden/web build` from the serving directory rebuilds the drifted
branch's code and reverts production, with no error and no diff to notice.

## Decision

**The serving checkout (`/home/b/projects/orden`) tracks `main`. Treat any other
branch there as a deploy hazard, not a workspace.** Feature/session work happens in
the per-session worktrees under `~/.orden/worktrees/`, never by checking out a branch
in the serving directory.

Deploy = rebuild that checkout's dist from `main`:

```
git -C /home/b/projects/orden checkout main
pnpm --filter @orden/web build
```

The host serves dist per-request, so a rebuild needs **no host restart** — `index.html`
is not immutable-cached, so a browser refresh picks up the new hashed bundle. Never
restart the shared `:4319` host casually; every live session's terminal and chat
depend on it.

When `main` is checked out in a *different* worktree (so the serving directory can't
also be on it), the non-disruptive deploy is to build there and mirror the output:

```
rsync -a --delete <main-worktree>/apps/web/dist/ /home/b/projects/orden/apps/web/dist/
```

`apps/web/dist` is gitignored, so this leaves no git state in the serving checkout.
Verify the deploy, don't assume it:

```
curl -s localhost:4319/ | grep -oE 'assets/index-[A-Za-z0-9_]+\.js'   # served index → hashed bundle
grep -l "<expected new string>" /home/b/projects/orden/apps/web/dist/assets/*.js
```

## Consequences

**Easier:**

- The "rebuild dist" half of the integration ritual is well-defined again: it always
  means "from `main`," and there's a documented way to deploy even when `main` lives
  in another worktree.
- A deploy is verifiable end to end (served `index.html` → hashed asset → expected
  string in the bundle), so "I rebuilt it" can't quietly mean "I rebuilt the wrong
  branch."

**Harder / residual risk:**

- Nothing *enforces* the invariant yet — it's a convention. A stray
  `git checkout <branch>` in the serving directory re-arms the trap. A guard
  (a pre-build check that refuses to build the serving dist off non-`main`, or a
  startup warning when the served `build-info` commit ≠ `main`) would make it
  self-policing; deferred until it bites again.
- The rsync path couples two working trees by hand. It's the pragmatic move for the
  current single-host setup; a real deploy step (build artifact → fixed serve path)
  would remove the coupling if this grows beyond one machine.
