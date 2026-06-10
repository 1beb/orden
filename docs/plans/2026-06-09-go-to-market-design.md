# Go-to-market design: selling orden v1

Date: 2026-06-09
Status: design agreed in discussion; launch gate replaces a calendar deadline.

The goal is explicitly stated: go end-to-end on selling a product — positioning,
packaging, a real transaction, a public launch, and a retro. Revenue is not the
success metric; a completed loop with strangers deciding whether to pay is.

## Decision summary

- Position orden as the operating layer for coding agents — not a note app.
- Persona: the heavy Claude Code / opencode user running multiple concurrent
  tmux sessions, who has stopped writing code and is about to stop reading it.
- Business model: source-available repo, sell the packaged build (the Aseprite
  model). $29 one-time via Lemon Squeezy. No service, no subscription, no DRM.
- Day-1 experience: import N days of existing claude transcript history as the
  onboarding centerpiece; resume is the adoption mechanism.
- Timeline: quality-driven, gated by a six-item falsifiable launch checklist.

## Positioning and narrative

The story is a graduation, told in three acts everywhere (page, video, HN post):

1. You stopped writing code. The agent writes it.
2. You are still reading it — in six tmux panes, reviewing diffs of code you
   did not write. Code review is a load-bearing habit that no longer pays.
3. The level above terminals: author intent in a journal, approve a plan, let
   agents work in isolation, read a rendered writeup, annotate it, and your
   notes flow back into the live session. The terminal stays one tab away,
   mirrored, for when you do not trust it yet.

Working one-liner: "You stopped writing code. Reading it is next. Orden is the
level above the terminal — plan, delegate, review writeups, annotate."

Show HN title draft: "Show HN: Orden — operate coding agents from an outliner;
review writeups, not diffs."

Contrast, stated on the page: Conductor, Crystal, and Claude Squad arrange more
terminals; orden replaces what you do with them. The tools-for-thought DNA
(journal, board, annotated documents) is the differentiator within the agent-ops
category — it is the texture of the pitch, not the market. Obsidian/Notion users
are not the buyers; agent power users who wish their workflow felt like Obsidian
are.

Honesty list, also on the page: local-first, single-user, claude/opencode only,
no cloud, no telemetry, Linux and macOS, no Windows in v1.

The persona stays narrow on purpose. One person, named precisely, fully served.
No "for teams," no "for everyone who takes notes."

## What is being sold

Software like this can sell exactly three things:

1. Gratitude — everything free, the key is a receipt. A donation, not a sale.
2. Permission — free personal use, companies pay. Enforcement is social; the
   buyer here is an individual. Even Obsidian made its commercial license
   optional in 2025.
3. Convenience — functionality is free if you build it yourself; the packaged,
   working, updating artifact costs money.

Orden sells convenience. Precedents: Aseprite (public source, compile free,
$20 binary, commercially successful), Ardour.

The model is the inverse of Obsidian's. Obsidian is closed source with a free
build, monetized through paid services (Sync, Publish) over a huge funnel.
Orden is open source with a paid build and no service. The inversion fits: this
audience's first question about an agent cockpit is "can I read the source?",
and a one-time price with zero servers matches a solo maintainer with no pager.
If orden ever grows a real service (synced vaults, managed remote hosts), the
Obsidian model becomes available as a second act — refused until strangers have
paid $29 for the build.

The SKU: Orden personal license, $29 one-time.

- The packaged app: signed artifact, native deps (node-pty) prebuilt, doctor
  checks wired, one command to the Journal.
- The updates channel for all v1.x (Lemon Squeezy download portal).
- A direct line to the maintainer.

The free path, stated proudly on the page: clone the repo, pnpm install, run
it. Full product, no nag, no crippled features. The gate is effort, not
encryption.

What the buyer believes they are buying: an afternoon of their life back, a
calmer way to run six agents than a pane farm, and confidence that the thing
updates. Price anchored against their existing agent spend — someone paying
$100-200/month for Claude Max does not deliberate over $29 once. The page
should make that adjacency visible.

## Product scope for v1

Import is the centerpiece; everything else is hardening the loop that already
exists (journal -> spawn -> plan -> annotate -> resume).

First run: the user adds projects by path. Orden globs
`~/.claude/projects/<encoded-path>/*.jsonl`, proposes the last N days of
sessions, and materializes the board and journal from the user's actual
history. Titles derive from transcripts via the existing titling path.

- Curation is the real work, not parsing: minimum-turn filter, recency
  weighting, substantive-title heuristics. Unfiltered import of a heavy user's
  history is a landfill and ruins the first impression.
- Historical sessions land in an archive treatment, never the active columns.
  Sessions with recent activity surface as resumable.
- Resume is the adoption mechanism: claude transcripts carry session ids; orden
  resumes by id, lifecycle hooks inject at relaunch, and the imported session
  becomes fully orden-native. Live attach to running sessions is sidestepped
  entirely — the promise is "your history is here; continue any of it from the
  board," not "we adopt your running panes."

Cut line. In: claude-only import, spawn/resume, board, journal, annotation
loop, terminal + chat tabs, Linux + macOS. Out: opencode import, Windows,
teams/multi-user, live attach, any other new feature.

## Packaging and distribution

- Paid path: a packaged artifact delivered through Lemon Squeezy. One command
  or download to a working app.
- Free path: clone + pnpm. Must actually work for strangers — the pnpm 11.5
  requirement, the 30-day dependency cooldown, and the node-pty build are
  friction to verify and document.
- First-run doctor checks: claude on PATH, tmux present, node-pty builds.
  Failures explain themselves; every HN visitor who hits a wall posts the
  wall, not the product.
- Repo goes public under an FSL-style source-available license (free to use
  and read, blocks orden-as-a-service, converts to MIT after two years).
  Before going public: secrets scan, full git-history audit (history ships),
  README rewritten as the landing page's twin.

## Commerce mechanics

- Lemon Squeezy as merchant of record: sales tax, EU VAT, invoices, license
  key issuance and download delivery are its problem.
- $29 one-time, 30-day "email me" refunds. The key is a receipt plus the
  updates channel; no enforcement in the app.
- Buy button on the landing page and quietly in the in-app settings footer.
- One real test purchase end-to-end before launch.

## Launch

Channels, in firing order on one day: Show HN (the main event), an X thread
led by the demo video, the Anthropic Discord, r/ClaudeAI. Be at the keyboard
all day; fast, unflustered comment replies are the marketing.

Pre-written answers for the predictable threads: why not just tmux; versus
Conductor/Crystal; security and trust posture; license rationale; Windows.

The demo video (90 seconds, one take, real product): write a block in the
Journal, spawn a session, the card slides to in-progress, the agent parks a
plan, read it rendered, annotate a paragraph, the note types itself into the
live terminal, the card moves. The annotation-to-terminal beat is the money
shot — the thing no competitor has.

### Launch gate

Quality-driven means this checklist is the finish line. When all six are
green, post on the nearest Tuesday morning; "it doesn't feel ready" stops
being admissible evidence.

1. Fresh VM: install command to visible Journal in under 2 minutes.
2. Import of real history runs clean on a second machine (tailnet boxes
   available: cubibox, ygxps).
3. Someone who is not the author completes the full loop unaided.
4. The 90-second money-shot video recorded on the real product.
5. Kill-test: host dies mid-session; relaunch recovers; no zombie state.
6. Landing page, README, trust doc live; buy button test-purchased.

## Learning

Decided before launch so it is measurement, not vibes:

- Pre-registered predictions, written and sealed: visitors, stars, sales, top
  objection.
- Captured during launch: page-to-buy funnel, install attempts vs completions
  (proxied by downloads and issue reports — no telemetry), verbatim
  objections, which positioning words strangers repeat back.
- One week post-launch: a written retro — predictions vs reality, what would
  change in positioning, packaging, pricing, and a deliberate keep / open /
  shelve decision.
- The meta-lesson to name explicitly: which step was avoided longest, and why.

## Open questions

- Name and domain: does "orden" survive a collision and availability check?
  Decide before page or store exist; rename is now or never.
- Free-path reality: verify clone-and-run works on a stranger's machine and
  decide how prominently the page advertises it.
- Support promise: what a buyer is owed (GitHub issues only vs email), stated
  on the page.
- Quiet beta: whether gate item 3 is one friendly user or a small private
  round before the public launch.
- Pricing shape: single $29 tier vs adding a supporter tier ($79, same bits).
- License text: confirm the exact FSL variant and its npm-publishing
  implications.
- Updates mechanics: portal re-download only, or a lightweight in-app version
  check (no phone-home beyond a static version file).
