# Orden MCP: kanban + session control

Design for a set of MCP tools that let an agent drive the orden kanban and
spawn sessions directly, replacing the raw-vault guess-and-check that agents
use today. Builds on the existing agent bus (`apps/host/src/mcp.ts`,
`mcpHttp.ts`), which already exposes `page_*` and `vault_*` over Streamable
HTTP and shares one `NodeHost` with the web (ws) bus.

## Problem

The server today offers only `page_*` and raw `vault_get/set/list`. To touch a
single kanban card an agent must `vault_list("cards")`, fetch each id to read
its title, string-match the one it wants, then `vault_set` a hand-rebuilt
`Item` object — dropping a field silently corrupts the card. There is no
first-class notion of "the card for this session," no guard on completion, and
no way for an agent to capture a new thought as a session without leaving the
thread.

## Goals

- Address one card directly by id or title — never enumerate the board.
- Resolve "my card" automatically from the calling session, with no lookup.
- Let the agent move a card through planning / in-progress / blocked freely,
  but never reach complete unless the user explicitly says so.
- Let the agent create a session for the current or any other project
  mid-thread; it lands in planning on the board instantly.
- Let the agent open a doc, page, the board, or a card in the user's main
  panel.

## Non-goals

- No new kanban columns. The four lifecycle states stay
  (`packages/outliner/src/kanban.ts`).
- No headless `claude -p`. Sessions remain the interactive TUI.

## Live sync (already in place)

Every vault write flows through `EmittingVault` (`nodeHost.ts`) onto the change
feed that the ws bus broadcasts. The web reacts per namespace in
`main.ts` (`onVaultChange`, ~line 1049): a write to `cards` re-hydrates and
re-renders the board and badge; `sessions` refreshes the session panel;
`projects` re-renders the project list. So any MCP tool that writes the vault
appears on the board live, with no extra plumbing. This design adds one new
namespace case (`ui` view-intent, below).

## Tool surface

Seven tools, alongside the existing `page_*` / `vault_*` (which stay):

```
card_get(target?)                  fetch one card by id or title; no arg = the current session's card
card_move(state, target?, note?)   set state to planning | in-progress | blocked; rejects "complete"
card_complete(target?)             the ONLY path to complete; call only on the user's explicit say-so
card_create(title, project?, notes?)   new card in planning; project defaults to the session's
session_create(title, project?, prompt?)   new session + linked planning card; launches per setting
project_list()                     id + name of every project, so other-project / title moves resolve
panel_open(target)                 open a doc, page, the board, or a card in the user's main panel
```

Conventions:

- `target` is always "id or title," resolved server-side. A miss returns a
  short "no card matches X; closest: …" with a few candidates — never a full
  board dump.
- `project` accepts an id or a name; unresolved names return the available
  names. Omitted, it falls back to the current session's project, else the
  default Homeroom project.
- Writes are field patches: the server reads the stored `Item` / `Session`,
  changes the one field, and re-persists the whole object. Agents never
  construct the object, so no field is ever dropped.

## Current-card binding (spawn-injected session id)

The MCP endpoint is one shared HTTP server; its transport id is a random UUID
(`mcpHttp.ts`), unrelated to the orden session. To make `card_move("blocked")`
resolve "my card" with no argument, the orden session id must ride along on the
request. Mechanism:

- Orden already spawns the agent with `claude --session-id <uuid>` and stores
  `<uuid>` as the session's `conversationId`; cards link back to the session.
- At spawn (the command-build path that today registers the global MCP server),
  register that session's agent against a session-scoped endpoint —
  `POST /mcp/<uuid>` (or an `X-Orden-Session: <uuid>` header). The server reads
  `<uuid>` off the URL/header per request.
- `card_get()` / `card_move()` with no target then resolve
  `<uuid>` -> session (match `conversationId`) -> linked card. No lookup, no
  listing. If the id is absent (e.g. an ad-hoc client), the no-target form
  errors with a clear "pass a target; this client isn't bound to a session."

## Completion protection

`card_move`'s state argument is typed to `planning | in-progress | blocked`;
`"complete"` is rejected at the schema. The only way to complete a card is the
separately named `card_complete`, whose description (and the server-level
instructions) state plainly: call it only when the user has explicitly asked to
mark something done. Splitting it into its own tool means a careless or
habitual `card_move` can never terminate a card — completion is always a
deliberate, named act.

## Session create + launch

`session_create(title, project?, prompt?)` mirrors the web's
`createSession` (`apps/web/src/sessions.ts`):

1. Write a `Session` record (ns `sessions`) with the title, agent (default
   claude), resolved project, and `initialPrompt` = `prompt ?? title`.
2. Drop a linked card into planning (ns `cards`), so it shows on the board
   instantly via the change feed.
3. Launch behavior keyed off a setting (ns `settings`, `sessionAutoLaunch`,
   default true):
   - true (default): spawn the interactive agent TUI immediately, handing it
     the `initialPrompt` — capture the thought and start working it.
   - false: capture only — the record and planning card exist; the user opens
     and runs it later.

The setting is surfaced in the web settings panel so the default can be
flipped without touching the agent.

## Open in panel

`panel_open(target)` lets the agent surface something in the user's main panel.
Targets: a repo doc path (review view), a page name, the literal `kanban`, or a
card id/title (opens the board, focused on that card). Mechanism, reusing the
change feed:

- The tool writes a view-intent record: ns `ui`, key `panel-intent`,
  value `{ kind, target, nonce }` (the nonce forces a distinct write each
  call so repeats still fire).
- `main.ts`'s `onVaultChange` gains a `ui` case that, on `panel-intent`,
  performs the matching navigation: `openRepoFile` for a doc, `openPage` for a
  page, `viewStore.set("kanban")` (+ card focus) for the board. Guarded so it
  never steals focus mid-edit, consistent with the existing files-change guard.

This is the capability that lets this very design open itself in the panel.
Until it ships, the bridge is the existing default-open path: write the doc as
a repo file and set `ui/last-doc` to `review:<path>`, then reload.

## Where the code lives

The card / session shapes, id generation, and state transitions live today in
`apps/web/src/cards.ts` and `sessions.ts` as cache-backed web modules. The host
tools need the same shapes and rules. To avoid two diverging definitions
(and the corruption risk that motivates this work), extract the pure pieces —
`newCard`, `newSession`, `applyState`, legacy-state normalization — into
`@orden/outliner` (which already owns `Card` / `CardState`). Both the web
modules and the host tools import them; the web keeps its cache wrappers, the
host writes the vault directly. Id generation in the host uses
`item_<time36>_<rand>` / `sess_<time36>_<rand>` (random suffix, not a
per-process counter) so host- and web-minted ids never collide.

Lighter alternative if the extraction is too big for one pass: replicate the
minimal shape + id logic in `tools.ts` and add a shared test asserting the two
stay in sync. Recommended path is the extraction; it is the durable fix.

## Tools wiring

`tools.ts` gains pure, MCP-SDK-free functions (`cardGet`, `cardMove`,
`cardComplete`, `cardCreate`, `sessionCreate`, `projectList`, `panelOpen`),
each taking `(host, …)` and returning the existing `ToolResult` shape. `mcp.ts`
registers them with zod input schemas, mirroring the current registrations. The
session-scoped id (from `mcpHttp.ts`) is threaded into the per-request tool
context so the no-target forms can resolve "my card."

## Server instructions

The MCP server gains an `instructions` block (the SDK supports server-level
instructions) stating the operating rules so they travel with the connection,
not just per-tool docs:

- Move cards as work progresses (planning -> in-progress; blocked when stuck).
- Never call `card_complete` unless the user explicitly says to finish/close.
- Capture stray ideas with `session_create`; it lands in planning for later.
- Use `panel_open` to show the user a doc/page/board when it aids the
  conversation.

## Error handling

- Unresolved card target: "no card matches X" + closest few titles.
- Unresolved project: list available names.
- No-target card op on an unbound client: explicit "pass a target."
- `card_move("complete")`: rejected at the schema with a pointer to
  `card_complete`.
- All tool bodies catch and return a `ToolResult` error string rather than
  throwing across the transport.

## Testing

- Pure tool fns over an in-memory `VaultStore` fake (the pattern in
  `apps/host/test`): card_get by id and by title (hit, miss, ambiguous);
  card_move across the three states; card_move rejecting complete;
  card_complete reaching complete; card_create landing in planning;
  session_create writing both the session and a linked planning card, honoring
  the launch setting; project_list; panel_open writing the intent record.
- Web side: `onVaultChange` `ui` case navigates per intent kind and is
  focus-guarded.
- Shared `@orden/outliner` factories: unit tests for shape, id format, and
  state transitions, asserting web and host agree.
- Manual: from a bound session, `card_move("blocked")` flips the live board;
  `session_create` for another project shows a planning card immediately;
  `panel_open` opens a doc in the running app.
