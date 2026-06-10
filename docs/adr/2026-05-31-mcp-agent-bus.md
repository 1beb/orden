# ADR-0008: MCP as the agent bus with session-scoped binding

**Date:** 2026-05-31
**Status:** accepted

## Context

Agents (Claude Code, opencode) need first-class access to the orden kanban and
session controls. Before this decision, agents used raw `vault_get/set/list` —
guess-and-check string matching against card titles, hand-reconstructing `Item`
objects, and silently corrupting cards on field omission. There was no notion of
"my card" or guard against accidental completion.

## Decision

**Expose kanban, session, page, and vault operations as MCP tools over a shared
HTTP endpoint (`POST /mcp`). Bind each agent's calls to its session via a
per-conversation URL path (`/mcp/<conversationId>`).**

Tool surface:

- `card_get(target?)` — fetch one card by id or title; no arg resolves the
  current session's card.
- `card_move(state, target?, note?)` — set state to `planning|in-progress|blocked`.
- `card_complete(target?)` — the ONLY path to `complete`; call only on the user's
  explicit say-so.
- `card_create(title, project?, notes?)` — new card in planning.
- `session_create(title, project?, prompt?)` — new session + linked planning card.
- `project_list()` — id + name of every project.
- `panel_open(target)` — open a doc, page, board, or card in the user's main panel.

Plus existing `page_*` and `vault_*` tools (kept). Later additions:
`doc_render({path})`, `learning_propose(...)`.

**Completion protection:** `card_move`'s state argument is typed to exclude
`"complete"` — rejected at the zod schema. `card_complete` is a separately named
tool whose server instructions state: never call unless the user explicitly asks.

**Session binding:** at spawn, the agent's MCP registration includes the session
scoped endpoint (`/mcp/<uuid>`). The server reads the id from the URL path per
request. No-target forms of `card_get`/`card_move` resolve via
`sessionForConversation(id)` → session → linked card. An unbound client gets an
explicit "pass a target" error.

**Rejected alternatives:**

- **Raw vault access only.** The status quo that motivated this work — error-prone,
  corruption-prone, and required agents to enumerate the entire board for every
  operation.
- **Separate MCP server process.** Would lose the shared vault and change feed
  that make kanban changes appear live. See ADR-0005.
- **MCP push for annotation delivery.** MCP servers cannot push unsolicited
  messages to clients. Annotations are delivered via TUI typing instead (see
  ADR-0010).

## Discussed in

Conversation `133fe10f-2853-47f0-902b-5e1495de659c` (2026-05-31):

> "We are going about things in a silly way. As an example, you can make decisions
> about what the status of the kanban card is internally. We should provide you with
> instructions and mcp to do it easily without too much noise. Right now, we're using
> some kind of lookup/check which is silly. The LLM can move it around if instructed
> how."

> "No, this is still silly. We shouldn't be listing all the cards we should just be
> retrieving a specific card using the name or id. The session id for the claude
> instance must be saved and we know what it is here by using the env var, what's
> the problem?"

> "Spawn injected makes sense. Proceed."

> "Capture and launch is the default. Create a setting that allows for just capture."

The original plan had the agent proposing to retire all hooks and drive state
entirely via `card_move`. This was corrected mid-conversation — the hooks stay for
the auto-cycle (the agent can't set `blocked` as its own last act), but they must
never clobber a completed card. The MCP was extracted into its own `@orden/mcp`
package during implementation to keep it independent of `apps/host`.

## Consequences

**Easier:**

- Agents get a clean, typed surface for kanban operations. No more manual object
  construction or field-dropping bugs.
- Server instructions travel with the MCP connection so operating rules are always
  present.
- Live sync is free: every vault write flows through the existing change feed that
  the web already subscribes to.

**Harder:**

- The session-scoped binding requires per-agent MCP server registration at spawn
  time — each agent runs with a different `/mcp/<id>` endpoint.
- Adding a new tool requires: zod schema, pure function implementation, server
  registration, and server instructions update. Four touchpoints per tool.
- State transitions driven by hooks (automatic) vs tools (deliberate) have an
  articulated division of labor that must be understood by agent prompt authors.
