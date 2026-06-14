# Worktree auto-trust

Date: 2026-06-10. Status: implemented.

## Problem

Every session launched in a fresh git worktree (`~/.orden/worktrees/<proj>/<sess>`)
hits Claude Code's "do you trust the files in this folder?" dialog. Claude keys
trust per directory in its config file (`~/.claude.json`, or
`$CLAUDE_CONFIG_DIR/.claude.json`) as `projects[<path>].hasTrustDialogAccepted`,
and its check walks UP ancestor directories — but orden worktrees live outside any
trusted ancestor, so every new worktree prompts again. The worktree is a checkout
of a repo the user already registered as a project and already runs agents in, so
the prompt carries no information. It should die.

## Decision

A global setting, "Auto-trust new worktrees" (`worktreeAutoTrust`, default on),
next to the isolation toggle. When ON and a **claude** session launches into a
worktree, the host pre-seeds `projects[<workdir>].hasTrustDialogAccepted: true`
in claude's config — but **only when the source repo itself is already trusted**
(checked with the same ancestor walk claude uses). Trust is inherited, never
widened: a repo the user never trusted still prompts.

Mechanics:

- `claude config set hasTrustDialogAccepted true` is deprecated (v2.1.170 prints
  guidance and writes nothing), so the host edits the config file directly:
  parse → merge the one project entry → atomic write (temp file + rename),
  2-space JSON matching claude's own formatting. Parse failure or missing file
  → do nothing (never clobber claude's config).
- Hooked in `resolveSessionCwd` (terminal.ts) right after worktree resolution —
  the single point every launch path (panel attach, launch-on-create, annotation
  relaunch) flows through, and the only place that already holds both the
  workdir and the source repo path. `SessionCwdRec` gains the `agent` field.
- Failures are warn-and-continue: a failed seed means one extra dialog, never a
  failed launch.
- opencode has no trust dialog; the seed is claude-only.

## Alternatives rejected

- Trusting the worktrees root (`~/.orden/worktrees`) once: one entry would cover
  everything via claude's ancestor walk, but blanket-trusts worktrees of
  projects the user never trusted.
- Per-project override (like `worktreeIsolation`): YAGNI — the inherit-from-repo
  check already scopes trust per project.

## Files

- `apps/host/src/claudeTrust.ts` (+ test) — config path, ancestor-walk check,
  `ensureClaudeTrust(workdir, repo)`.
- `apps/host/src/worktrees.ts` — `readWorktreeSettings` gains `autoTrust`.
- `apps/host/src/terminal.ts` — seed call in `resolveSessionCwd`.
- `apps/web/src/settings.ts`, `apps/web/index.html`, `apps/web/src/main.ts` —
  the toggle.
