# Project pages brainstorming

Date: 2026-05-29

Status: design agreed — ready to plan implementation

## Purpose

Decide what an orden "project page" should contain and do. Working doc — we fill
it in together as we talk through it.

## Current state

A project is a named work location (`projects.ts`): ephemeral, local path, ssh,
or s3 source. Its page today (`projectPage.ts`) is a minimal issue tracker:

- Title and a one-line source meta (path / "ephemeral project" / source kind)
- An "Add an item…" box
- Items grouped into collapsible sections by lifecycle state, each item with a
  state dropdown

Related pieces that already exist elsewhere in orden:

- Kanban board (cards), separate-but-linked to sessions
- AI sessions (claude/opencode), each linked to a backlog card
- Pages (wiki-linked markdown outlines) and the Journal
- Repo file browser + annotation/review of markdown docs

## Open questions

All resolved — see Decisions and Design below. Remaining detail deferred to the
implementation plan (e.g. exact activity-feed event sources, notes-page naming
scheme, how the C/O launcher reuses the sessions panel's create flow).

## Decisions

- Primary role: mission control. Landing on a project page should give an
  at-a-glance sense of the project (status, active sessions, recent activity)
  plus quick actions to start work. Work items are one widget among several,
  not the whole page.
- Page contains three widgets: Active sessions, Items by state, Project notes.
- Layout: single column, stacked top-to-bottom (Sessions, Items, Notes).
- Project notes are a real orden Page (outliner block tree) keyed to the project,
  embedded in the widget. Reuses [[wiki links]] + backlinks; the page also appears
  in the Pages index. No separate notes store.
- A 4th widget: recent-activity feed (reverse-chron) at the bottom — sessions
  started/finished, items moved between states, notes edited. For re-orienting
  when returning to a project after time away.
- Sessions and Items stay separate widgets, not merged: most cards are agent-less
  work, so a merged list would distort the backlog.
- Items↔sessions stay lightly cross-linked (confirmed): each item carries an
  optional "start agent" action (the C/O brand marks) that spawns a session
  linked to that card and scoped to the project. Items with a linked session show
  a small brand-mark indicator that jumps to the session; agent-less items show
  nothing. This completes the existing one-way link (today a session auto-creates
  a card) without forcing an agent onto every card.
- "Items by state" groups by the current four lifecycle states: Planning,
  In-progress, Blocked, Complete (the board was reduced to these).

## Design

The project page is mission control for one project: a single, full-width column
of stacked widgets, top to bottom. No stats header.

1. Active sessions — the live claude/opencode sessions for this project, each
   showing its title and status, click to open. The C/O brand-mark buttons start
   a new session scoped to this project (same affordance as the sessions panel).
2. Items by state — the work backlog, grouped into Planning / In-progress /
   Blocked / Complete with an add-item box and per-item state control. Each item
   also offers an optional C/O "start agent" launcher and, if it already has a
   linked session, a small brand-mark indicator linking to it.
3. Project notes — an embedded orden Page (outliner block tree) keyed to the
   project. Full [[wiki link]] + backlink support; it also surfaces in the Pages
   index. This is the single source for the project's notes — no parallel store.
4. Recent activity — a reverse-chronological feed: sessions started/finished,
   items moved between states, notes edited. For re-orienting after time away.

Data/reuse notes:

- Items are the existing cards (`cards.ts`); sessions are the existing sessions
  store. The page composes what's already there rather than introducing new
  models. The notes Page reuses the outliner + pages store.
- The item→session launcher reuses the sessions create flow (which already drops
  a linked card); from an item we instead start from the existing card and attach
  a session to it.

## Out of scope (YAGNI)

- Status / stats header bar (counts of sessions / open / broken, quick-action
  shortcuts). Considered and cut for now — can revisit if the page feels like it
  lacks an at-a-glance summary.
