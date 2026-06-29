# Sharing Links — Design Considerations

**Status:** Thinking, not built. This captures the design conversation that
followed shipping in-instance hash deep-links (see "Relationship to shipped
work" below). It is the seed for a future **Sharing** card.

**Goal:** Let one orden instance hand another instance (or another user) a link
that reproduces a specific surface — a document, a page, a review writeup —
across instances, not just within one.

---

## The problem with instance-local ids

Orden's entities carry instance-local row ids (`proj_mprhz6zm`,
`sess_mqvt38e5`). A URL built from those resolves on exactly one vault. That is
fine for *personal navigation* (your tabs, your reload, your back button) and
useless for *sharing* — the receiver's vault has no row with that id. The
question "how do we share a link" is really "what portable identity do we put in
the link, and who resolves it."

## The conceptual split

Mature services (Google Docs, Dropbox, Notion, Figma, Linear, GitHub) all draw
the same line:

- **Identity in the URL; ephemeral state out.** The URL says *what resource*.
  Live things (cursor, presence, which panel is open, scroll) never go in the
  URL — they travel over a realtime channel.
- **The identity is a service-level handle, not a row id.** Docs' doc-id,
  Dropbox's share token, Linear's `ENG-123`, GitHub's `org/repo` all resolve
  *server-side*, on any account with access.
- **The resource is the path, not a query param** (`docs.google.com/document/d/<id>/edit`),
  with params reserved for flags/context.
- **The only "state" tolerated in the URL is a position *inside* the resource**
  (`#L42`, `#heading=…`, Figma's `node-id`) — never UI chrome.

Dropbox makes the dichotomy explicit with two distinct URL shapes for two
distinct jobs:

```
dropbox.com/home/Work/report.pdf      ← personal navigation (a path; your account)
dropbox.com/s/<token>/report          ← sharing (a server-resolved token)
```

Orden should mirror this. The hash deep-link (shipped) is the `/home/...` layer.
**Sharing is a separate concern** — and, per the discussion below, a separate
*host service*, not more web-side URL plumbing.

## Sharing as a host service (plugin)

Sharing should be an optional `Host` capability — `host.sharing` — gated in
`capabilities()`, exactly like `chat`, `spawnSessions`, `docRender`, and
`terminalChat`:

- **BrowserHost** omits it (the pure web app doesn't share).
- **NodeHost** provides a single-user implementation.
- A future **enterprise host** swaps in a real multi-tenant backend.

This is squarely on-pattern: orden already factors optional backends as host
capabilities, and "acts like a plugin" = a capability with a swappable backend.
The web UI only depends on the `Host` interface, so it is oblivious to which
backend is present.

## The descriptor datastore (the heart of it)

A share link carries (or resolves to) a **descriptor** — a small record that
"explains where it is." The crux, which shows up immediately: a local file path
(`/home/b/orden/src/main.ts`) is *not* a location anyone else can reach. So a
descriptor must say one of two things:

```js
// (a) "fetch it from a place you can both get to"
{ kind: "repo-file",
  source: { github: "acme/widgets" },   // network-reachable
  path: "src/main.ts",
  at: "abc123" }                         // commit = pinned snapshot

// (b) "it's not anywhere you can reach — the content is in the sharing store"
{ kind: "review-doc",
  storeRef: "sha256:9f3a…",              // snapshot lives in the sharing store
  title: "Refactor plan",
  rendered: "html" }
```

So the sharing service is really two things: a **content store** (for things with
no network source — review docs, pages, transcripts) and a **directory** of
descriptors keyed by token. The token in the link (`/s/<token>`) looks up the
descriptor; the descriptor explains how to materialize it. Without the store,
local-only content literally cannot be shared — which is why a store is
*necessary*, not optional, for any non-network-sourced resource.

## Per-kind share plugins

Each shareable *kind* (repo-file, review-doc, page, session-output) owns its own
descriptor schema plus a packager/unpackager. This is the exact pattern orden
already uses twice — chat harnesses ("adding a harness = one adapter file +
widening the union") and the center-view registry. So "share a review doc" and
"share a repo file" are two plugins, not one switch. The sharing service
dispatches by `kind`.

## Open forks (decide before building)

1. **In-link vs store-backed token.** Is the descriptor *embedded* in the link
   (fat, self-contained, no server read, but irrevocable and exposes locating
   info) or *behind a token* in the store (short, revocable, mutable, needs the
   service up)? **Lean: store-backed** — it is required anyway for local
   content, and it buys revocation + access control.
2. **Live ref vs snapshot.** Repo file pinned at a commit (snapshot) vs
   always-latest? **Lean:** network-sourced things can be live-ref; local/store
   things are snapshots by necessity; review docs are always snapshots (you
   review a specific render).
3. **What is shareable first.** Review docs (agent writeups) are the
   highest-value, easiest case — pure content, already rendered, already the
   artifact you would hand someone. Repo files need source-access logic.
   **Lean: start with review docs.**

## Relationship to the shipped deep-linking

Nothing is wasted. The flow is:

```
share link  →  host.sharing.resolve(token)  →  descriptor  →  applyNav  →  openers
```

The shipped hash deep-link mirrors navigational state → applies via the same
openers (`openRepoFile`, `openProject`, `openPage`, `viewStore.set`). A resolved
share descriptor is just another input to that same "materialize" step. The hash
URL handles personal navigation; the sharing service handles portability; they
meet at the openers and do not otherwise entangle.

## Project handle upgrade path

The shipped deep-links reference projects by **name** (case-insensitive,
resolved via `findProjectByName`). For in-instance links this is low-risk — same
resolution `[[Project:]]` wiki links already used, graceful fallback on rename or
collision. The resolver is the single swap point for stronger handles:

- **name** (today) → portable-ish, mutable, can collide.
- **immutable slug** (medium term) → stable under renames, unique. Adds a
  `Project` field + project-modal input + migration; one resolver change.
- **`org/repo` or network source** (enterprise) → the handle a sharing service
  would actually emit, since it is resolvable beyond one vault.

Each step changes `findProjectByName` (and what the sharing service writes into a
descriptor), not the URL format or its consumers.
