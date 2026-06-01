# Card log + journal-on-complete

Status: accepted, implementing
Date: 2026-06-01

## Goal

When the agent marks a card complete, append a short summary to today's journal.
Give each card a per-card log page for richer narrative, and let the agent
associate a planning document (a `docs/plans/*.md` repo file) with a card.

## Decisions

- Trigger is the existing `card_complete` MCP tool (agent-driven, not host
  auto-write on UI clicks). It gains an optional `summary` param.
- Journal entry lands on today's dated journal page: vault ns `pages`, key
  `journalKey(new Date())` (ISO `yyyy-mm-dd`) — the page the web shows as Today.
- Each card gets a log page at `pages` key `card:<id>`, mirroring project notes
  (`notes:<id>`): editable in the outliner, `[[wiki-linkable]]`, in the Pages index.
- The card's freeform `notes` string is retired. It was write-only (set by
  `card_move`/`card_create`, returned by `card_get`) and rendered nowhere in the
  web UI. The log page replaces it as the single home for card narrative.
- Planning docs stay as git-tracked `docs/plans/*.md` repo files. The card stores
  the path in a new `planDoc` field, set by the agent via a new `card_set_plan`
  tool. The link is shown textually (not a clickable repo-path link inside
  outlines — that wiring is out of scope).

## Entry formats

Journal (today's page), plain markdown bullet, no emoji:

```
- 14:32 Completed "Wire MCP journal entries" — <summary> [[Project: Orden]] · plan: docs/plans/2026-05-31-foo.md
```

- Time prefix is UTC `HH:MM`, consistent with the UTC date key (never lands on the
  wrong day's page).
- `[[Project: <name>]]` is the canonical project link; name resolved from
  `card.projectId`, falls back to the id if the project record is missing.
- ` · plan: <path>` suffix only when `card.planDoc` is set.

Card log (`card:<id>` page):

- `card_move`: `- HH:MM <state>: <note>` (only when a note is given).
- `card_complete`: `- HH:MM Completed — <summary>` (summary optional).

## Changes (all in packages/mcp)

### tools.ts

- Helper `appendToPage(host, key, line)`: read current md, append line (newline
  separated), write back. Creates the page if absent.
- Helper `journalLine(...)` / `projectLink(vault, projectId)`: format the bullet,
  resolve project name to `[[Project: name]]`.
- `cardLogKey(id) => `card:${id}``.
- `cardMove(vault, target, state, note?)`: when `note` given, append to the card
  log page instead of `card.notes`. Stop writing `card.notes`.
- `cardComplete(vault, host, target, summary?)`: set state complete; append
  `Completed — summary` to the card log; append the journal bullet to today's page.
- `cardCreate(... notes?)`: seed the log page's first line with `notes` instead of
  setting `card.notes`.
- `cardSetPlan(vault, host, target, path)`: validate path starts with
  `docs/plans/` and exists (host fs); set `card.planDoc`; error otherwise.
- `cardGet`: return `log` (card log page body, falling back to legacy `card.notes`
  if no log page exists) and `planDoc` in the JSON, in place of `notes`.

### server.ts

- `card_complete`: add `summary` to schema; pass host.
- `card_move`: unchanged schema; pass host.
- new `card_set_plan` tool: `{ target?, path }`.
- INSTRUCTIONS: note that completing a card writes a journal summary; mention
  card_set_plan.

## Tests (packages/mcp/test)

- card_complete: appends title + summary + `[[Project: name]]` to today's journal;
  creates the journal page when missing; appends (doesn't clobber) when present;
  still sets state complete; works with no summary; includes plan suffix when set.
- card log: card_move with a note appends to `card:<id>`; card_complete appends a
  Completed line; card_get returns the log body; legacy notes fallback.
- card_set_plan: sets planDoc; rejects a non-docs/plans path; rejects a missing file.

## Out of scope

- Clickable repo-path links inside outlines (plan link is textual for now).
- Host auto-write on UI-driven completion.
- Migrating existing `card.notes` strings (lazy fallback only).
