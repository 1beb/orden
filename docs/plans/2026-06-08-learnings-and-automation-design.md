# Intelligent automation: host-rendered docs and the learnings surface

Design for two process automations in orden, settled in a brainstorming session on
2026-06-08. Mockup of the review surface: `docs/mockups/learnings-review.html`.

## Goal

Encode recurring agent behaviors as deterministic process, not agent discretion. Two
flows came out of the discussion:

1. Rendering a doc (qmd/md) is host-executed but agent-orchestrated, and the result is
   pushed to the main panel.
2. Completing a card distills the session's work into reviewable learnings — proposed
   edits to README / ADRs / AGENTS.md / skills — that the user triages one at a time.

## Flow 1: host-rendered, agent-driven docs

The render always runs on the host (it owns quarto, the env, render errors). The agent
orchestrates: it triggers the render, blocks on the result, verifies success, then
surfaces it. Two MCP tools, kept separate on purpose so the verify-then-open step stays
an explicit gate:

- `doc_render({ path })` — host runs quarto synchronously, returns
  `{ ok, outputPath, errors }`. Build only; surfaces nothing.
- `panel_open({ kind: "doc", target: outputPath })` — existing tool, surfaces the
  result in the main panel.

Agent procedure: edit the `.qmd`/`.md` source, call `doc_render`, check `ok`; on success
`panel_open(outputPath)`, on failure read `errors` and fix without touching the panel.
Re-render-on-annotation is the same loop with no special case: annotation comes back →
edit source → `doc_render` → verify → re-`panel_open`.

## Flow 2: learnings on card-complete

`card_complete` is the trigger, not a gate. Completion stays the user's explicit call
(unchanged `complete` semantics). Firing complete generates learnings from the session's
diff and transcript, and the card lands in a new `learnings` column to the right of
`complete` — a post-completion review surface holding the generated proposals.

### Learning model

A learning is a single proposed artifact change, uniform regardless of target:

- `type`: `readme` | `adr` | `agents` | `skill`. No memories.
- `title`, a short `recap` (per-learning, see below), and a proposed change — a diff for
  edits (README/AGENTS), or new-file content for creates (ADR, skill).
- `status`: pending / accepted / rejected, plus a comment thread.

Treating all four types as "one or more proposed file changes" keeps accept trivial.

### Triage decisions (locked)

- Recap is per-learning, shown inline at the bottom of each learning (always visible,
  not collapsed, including on mobile).
- The stepper handles one card at a time — not a global queue across cards.
- Triage is per individual learning: accept / reject / comment, and any action
  auto-advances to the next pending learning.
- Comment is an inline box with a Send button under the accept/reject row; it sends
  notes back to the agent to redraft that learning.
- A card leaves the `learnings` column once every learning is triaged, so the column is
  a live worklist of pending learnings, not a graveyard.

### Accept behavior

Accept is the approval — there is no second touchpoint. Where the edit lands depends on
the target directory:

- If the target is inside a git repo, the accepted edit is staged as a commit / PR for
  normal review, never silently pushed to a branch the user didn't expect.
- Otherwise (non-repo working dir), the edit is written straight to disk.

Reject discards the learning. Comment sends feedback to the agent to refine it.

## Review surface (main panel)

A new `learnings` view in `#view-area`, mobile-first. Layout, per the mockup:

- Header: `Learnings` label, progress (`1 / 3`), a segmented dot indicator, the learning
  title, and a quiet kind line (`Update · AGENTS.md`, `New file · skill`).
- Body: a `Proposed change` label, the file path, and a plain diff — ink text with
  `+`/`-` gutters, no green/red fills.
- Recap: a `Why this` section at the bottom — a thin divider, a small label, the text.
  Always visible.
- Action bar, sticky to the bottom: an `✕ Reject` / `✓ Accept` row, then a `Comment…`
  field with a Send button beneath. Accept and Send use the sessions UI soft-purple
  (`--accent-soft` background, `--accent` text). Reject is neutral ink.

Mobile is a single full-bleed column with the action bar pinned to the bottom and
thumb-sized controls; desktop is the same column centered at reading width.

## Flow 3: AGENTS.md drift on merge to main

Capturing incremental drift as it lands, not on a clock. A git hook on main
(post-commit / post-merge) pings the host `/hooks/` endpoint; the host spawns a
short-lived custodian session that compares each `AGENTS.md` against its subtree. Its
findings deposit into the same learnings surface (type `agents`) rather than inventing a
separate review model — one review surface, two triggers: card-complete (this session's
work) and merge-to-main (repo-wide drift). The custodian proposes; it never writes to
main silently.

## Deferred / not now

- Generating the recap and the proposed diffs is reasoning work done by the
  completing/custodian agent; the exact prompt and diff format are an implementation
  concern.
- A `learnings-review` skill encoding the triage procedure (itself one of the example
  learnings in the mockup) can follow once the surface exists.
