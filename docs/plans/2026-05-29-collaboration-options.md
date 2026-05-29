# Orden Collaboration Options — Design Comparison and Shallow Plan

Captured 2026-05-29. Decision-support for making Orden collaboration-compatible.
This is not a build spec; it weighs approaches against the current codebase and
recommends a first step. The design docs explicitly defer real-time
collaboration but keep the door open (ProseMirror plus Yjs); this document
re-opens that door and asks what the cheapest honest path actually is.

## The premise that changes everything

Today markdown files are the source of truth. ProseMirror serializes back to
markdown; the agent reads and writes markdown over SFTP; annotations live as a
sidecar log keyed by ProseMirror mark ids. This is a single-writer model: one
human in the editor, one agent on the filesystem in a worktree, mediated by the
Save button and the review loop.

Real-time collaboration breaks that premise for one surface in particular. If
two clients edit the same document concurrently, the live source of truth must
move out of the markdown file and into a shared structure (a CRDT document, an
OT server's authoritative copy, or a lock that forbids the second writer).
Markdown then demotes to two roles: durable serialization, and the agent's I/O
format. Everything downstream of "markdown is truth" — the SFTP save path, the
agent's edit-the-file workflow, cold-start re-anchoring — has to be reconsidered
for the surfaces that go collaborative.

The honest framing: collaboration is not one feature. It is a per-surface
decision, and the document editor is the only genuinely hard case. Most other
surfaces (kanban, annotation log) are shared *state*, not shared *text*, and a
plain synced key/value store covers them.

## Two buses, restated

Orden already has the transport split it needs:

- UI to host: control RPC (the WebSocket JSON-RPC in the host-backend plan).
  Collaboration adds presence, lock, and document-sync messages on this bus.
- Agent to Orden: MCP. The agent receives `open_in_main_view`, sends state
  transitions, and (today) receives annotations and chat. Collaboration asks
  whether the agent also speaks an *edit* protocol here for prose.

No third bus is required for the cheapest paths. CRDT sync can ride the existing
WebSocket; a lock service is a handful of new RPC methods. Only a hosted,
multi-tenant deployment forces the harder infrastructure questions, and those
are already deferred to a separate commercial plan.

## 1. Comparison of approaches

The five candidates, scored against the dimensions that matter for Orden. "Local
host" in the table means a single-user NodeHost on the user's own machine — the
common case — versus a shared/hosted NodeHost serving multiple humans.

| Dimension | Pessimistic locking | Optimistic presence only | OT (ShareDB) | CRDT (Yjs + y-prosemirror) | Naive (manual/git merge) |
|---|---|---|---|---|---|
| Real-time co-edit | No (serialized) | No (last save wins) | Yes | Yes | No |
| Offline / local-first | Yes (lock is advisory) | Yes | Weak (needs server, transforms) | Strong (designed for it) | Yes |
| Conflict semantics | None possible (one writer) | Silent loss on concurrent save | Server-resolved, no loss if connected | Convergent, no loss by construction | Explicit conflicts, manual resolve |
| Can data be lost? | No | Yes (last-writer-wins clobbers) | No (while connected) | No (merges all ops) | No (but user must resolve) |
| Implementation effort | Low | Low-medium | High | Medium-high | Low |
| Server / infra required | Lock registry only | Presence relay only | Authoritative OT server, always-on | Sync relay (stateless-ish) plus persistence | None (filesystem/git) |
| Agent compatibility | Good (agent takes/respects lock) | Poor (agent save races human) | Hard (agent must emit ops) | Medium (agent edits via interface or diffs in) | Good (agent already does files) |
| UX familiarity | Very high (Office/Perforce check-out) | High (Google-Docs cursors) | High (Google Docs) | High (modern editors) | Medium (developers only) |
| Retrofit cost vs current Orden | Low | Low-medium | High (replace PM editing model) | Medium (PM is built for it; stores are not) | Very low |

### Pessimistic locking / check-out with presence

One writer at a time. A client acquires a lock on a document before editing;
others see "being edited by X" and open read-only. No concurrent edits, no merge
algorithm, no convergence math. This is the cheapest path that still feels like
collaboration, because the thing most users actually want first is *not to clobber
each other* and *to see who is in a file* — both of which locking delivers
without touching the editing model at all.

It fits Orden unusually well. The host already owns the SFTP save path and the
session manager; a lock is just another piece of host-owned state with a TTL.
Markdown stays the source of truth. ProseMirror is untouched. The agent becomes a
lock participant: before it writes a prose document it takes the lock (or is
refused and queues). The cost is the obvious one — no two people type in the same
doc at once — which for a review-loop tool with two human touchpoints is a mild
constraint, not a dealbreaker.

### Optimistic presence only

Show who is here and render remote cursors/selections, but do nothing to prevent
concurrent edits — on save, last writer wins. This is deceptively cheap to *show*
and dangerous to *trust*: the presence layer implies collaboration the save model
does not honor, so concurrent edits silently lose data. For Orden specifically
this is the worst of the table, because the whole product premise is "Save, then
the agent reacts now" — a clobbered save corrupts the review loop quietly. Useful
only as the awareness *layer* on top of locking or CRDT, never as the conflict
strategy on its own.

### OT (operational transform, e.g. ShareDB)

The Google-Docs-classic approach: clients send operations, an authoritative
server transforms concurrent ops into a consistent order. Real-time, lossless
while connected, mature. But it demands an always-on authoritative server (poor
fit for local-first and for the "same UI, local Node service" goal), and every
writer — including the agent — must emit transformable operations rather than
write a file. That is a large retrofit: ProseMirror's collab module can speak OT,
but the agent's filesystem workflow does not, and Orden would carry server
infrastructure it otherwise does not need. OT's main historical advantage over
CRDT (smaller document overhead) is not decisive here. Hard to justify when Yjs
exists.

### CRDT (Yjs + y-prosemirror)

The design doc already names this as the migration path, and it is the right
full-real-time target. y-prosemirror binds a Yjs document to a ProseMirror editor
directly; offline edits merge on reconnect by construction; the sync relay can be
nearly stateless and ride the existing WebSocket. The retrofit is real but
bounded: ProseMirror was built with this in mind, so the *editor* change is
mechanical. The genuine work is elsewhere — the source-of-truth shift (Yjs
becomes live truth, markdown becomes serialization), persisting the Yjs doc,
reconciling the agent (which still edits markdown files) against the live CRDT,
and re-homing the annotation marks (PM marks map cleanly onto y-prosemirror, but
the cold-start re-anchoring story changes when the doc is a CRDT rather than a
reloaded file). Medium-to-high, but the only credible path to true co-editing.

### Naive (manual merge / git-style conflicts)

Let both sides write the file and reconcile with diff/merge or git conflict
markers. This is essentially what Syncthing would give, and the design doc has
already rejected it for the transactional review path: eventual consistency and
conflict files break "Save, then the agent reacts now." It remains fine for
background/bulk movement and for the *code* side of the split (the agent already
works in a git worktree with async diff-and-review). As a human-facing
collaboration strategy for prose it is a non-starter.

## 2. Per-surface analysis

Orden is not one collaborative surface; it is several with different needs.

### Documents (ProseMirror editor)

The hard case, and the only one that needs a real co-edit decision. This is plan
documents and review writeups in the central pane. Concurrent human-plus-human or
human-plus-agent editing here is where conflict semantics bite. Options in
increasing cost: lock the document (cheapest, fits today's model), or move it to
a Yjs CRDT (real-time, source-of-truth shift). Recommended: lock first, CRDT only
if simultaneous editing of one prose doc becomes a real need.

### Annotations (marks plus log)

Shared *state*, not shared text. The durable log is already a content-addressed,
id-keyed store (W3C-shaped annotation bodies keyed by mark id). It is close to a
CRDT-friendly map already: concurrent adds of distinct annotations do not
conflict; the only contended field is per-annotation status/thread, which a
last-writer-wins or simple per-field merge handles acceptably. This surface suits
a simple shared store and does *not* need document-grade co-editing. The marks
themselves live in the PM document and follow whatever the document surface
chooses (lock or CRDT).

### Journal / pages outliner

Also a ProseMirror surface, but with a crucial difference: it is single-user by
intent (the daily log, no session attached, edits just save locally per the
routing rule). Multi-user editing of someone's own journal is not a real
requirement. Treat it like documents but default to no collaboration; lock if a
shared journal ever appears. Lowest priority.

### Kanban / project / session state

Pure shared state. Cards are projections of sessions; the board is a list with
states and positions. This is the textbook case for a synced key/value or
last-writer-wins-per-field store: two users moving different cards never
conflict; two users moving the *same* card resolve trivially. No CRDT text, no
locks needed — just sync the `host.sessions` store. This surface can go
collaborative early and cheaply, independent of the document decision.

### Sessions (co-watch vs co-drive)

Two distinct problems hiding under one word.

- Co-watch: many viewers attached to one pty/transcript. Cheap and safe — the
  pty stream and the JSONL/transcript adapter are read-only fan-out. Multiple
  WebSocket subscribers to one tmux pane. No arbitration needed. This is the
  natural first collaborative session feature.
- Co-drive: many humans sending input to one singleton agent. This needs
  arbitration because a tmux pane has one input stream and an agent has one
  conversation. Three models: single driver plus explicit handoff (cheapest,
  matches a lock — "X is driving"), turn-taking, or an input queue. Recommend
  single-driver-with-handoff, which is conceptually the *same lock primitive* as
  document locking applied to the pty.

### Identity and presence

A prerequisite for everything above. Today Orden has no identity layer — a single
implicit user. Locks need an owner; presence needs names and cursors; co-drive
needs a driver. This is a small but unavoidable new layer: a user identity per
connection, surfaced in the host's RPC. It is shared by every collaboration
approach, which is why it is the recommended first step (see section 6).

## 3. The file-lock model in depth

Locking deserves first-class treatment because it is both the cheapest path and
the one matching the mental model of users coming from check-out/check-in tools
("this file is being edited by X, Y, Z").

### Lock acquisition via the host

The host owns the vault, the SFTP save path, and the session manager, so it is
the natural lock authority. A lock is host-owned state, conceptually:

```
Lock {
  resource: { projectId, path } | { sessionId }   // a document or a pty
  owner: UserId
  acquiredAt, heartbeatAt: timestamp
  ttl: seconds
}
```

New RPC on the existing UI-to-host bus: `lock.acquire(resource)`,
`lock.release(resource)`, `lock.heartbeat(resource)`, and a `lock.list` /
presence broadcast so every client sees current holders. Acquisition is
first-writer-wins at the host; a second `acquire` returns the current owner
rather than a lock.

### TTL and heartbeat

A held lock carries a TTL and the editing client heartbeats while the document is
open and focused. This is the same mechanism the design doc already plans for
stall detection (no pty output and no MCP heartbeat for a tunable interval), so
the heartbeat plumbing is partly reusable. A lock whose heartbeat lapses past TTL
becomes *stale*.

### Stale-lock takeover

A stale lock must be reclaimable, or a crashed client wedges a document forever.
When a client requests a resource whose lock is stale, the host offers takeover:
the requester acquires, the old owner (if it ever returns) is told its lock was
broken and its buffer is now read-only/needs reconciliation. Takeover must be
explicit and visible, never silent, because the displaced writer may have unsaved
local edits — surface them as a recoverable buffer rather than discarding.

### Read-only-while-locked UX

When a client opens a document locked by someone else, the editor mounts
read-only with a banner: "Editing by X." The morphing action bar suppresses Save
(there is nothing to save) but *may* still allow annotations, since annotations
are a separate id-keyed store and do not contend with the document text — a
reader can comment while X edits. A "request edit" / "take over when idle"
affordance is the polite handoff path.

### Where locking is sufficient

For Orden's actual loop — review documents, two human touchpoints, an agent
working in isolation — locking is sufficient for documents and journal. It is
also exactly the co-drive arbitration primitive (a lock on the pty = "X is
driving"). It is *not* sufficient when genuine simultaneous typing in one prose
document is a hard requirement; that is the only case that forces CRDT.

### How locking complements a CRDT

Locking and CRDT are not mutually exclusive — they answer different questions.
CRDT answers "how do concurrent edits converge"; locking/presence answers "who is
here and who holds what." Even in a fully CRDT world you still want awareness
(remote cursors, "X is also editing"), and y-prosemirror ships an *awareness*
protocol that is exactly presence. So presence survives the CRDT migration; only
the hard *lock* (forbidding the second writer) is dropped where CRDT takes over.
Concretely: build presence now as part of locking, and if CRDT lands later, the
presence layer is reused and the exclusivity is relaxed. Nothing built for
locking-plus-presence is wasted by a later CRDT.

## 4. The agent as collaborator

The proposed split is the right frame: prose documents the agent edits through an
Orden edit interface (becoming a live collaborator); code the agent edits on the
filesystem in a worktree with async diff-and-review. Each approach treats the
agent differently.

- Under locking: the agent is just another lock participant. Before it writes a
  prose document via the edit interface, it takes the lock (or is refused and
  queues / signals blocked). It respects human-held locks, and humans see "being
  edited by agent." This is clean and requires no new merge logic — the agent's
  prose writes serialize against humans exactly like a second human. For code, the
  agent stays on the filesystem; no lock, the worktree *is* the isolation, and
  diff-and-review is the reconciliation. The agent participates in locks/presence
  for prose, and in presence-only (visible as a session) for code.

- Under optimistic presence only: the agent racing the human on save is the
  data-loss case made worse by automation — the agent saves fast and often. Avoid.

- Under OT: the agent must emit operations, which its file-writing workflow does
  not. Forces a translation layer (file diff to ops) or a full edit-protocol
  client in the agent. Heavy.

- Under CRDT: the cleanest *concurrent* story but the subtlest reconciliation.
  The agent still thinks in markdown files; the live doc is a Yjs CRDT. Either the
  agent writes through an Orden edit interface that applies its changes as CRDT
  ops (the "live collaborator" model — preferred), or the agent writes the file
  and Orden diffs the file against the serialized CRDT and applies the diff as
  ops. The second is a diff-to-CRDT bridge and is where subtle bugs live.

Across all approaches the split holds: prose = the agent joins Orden's
collaboration model; code = the agent stays on files in a worktree and
reconciles asynchronously. Locking makes the prose side nearly free because the
agent reuses the same primitive as humans.

## 5. Shallow implementation plan

Phased and architectural, not task-level TDD. Two tracks converge: a
"cheapest-viable" path (locking plus presence) that delivers collaboration
quickly, and a "full real-time" path (CRDT) layered on only if needed. Both
assume the host-backend plan (NodeHost, the `Host` interface, stores behind
`host.vault`) is in place — collaboration is most honest *after* that refactor,
because today's localStorage stores must become sync-ready host stores first.

### Phase C0 — Identity and presence (prerequisite)

What: add a user identity per host connection and a presence broadcast (who is
connected, what resource each has open). New RPC on the UI-to-host bus; render
presence in the nav and document header.

Trade-off / give up: introduces an identity layer Orden does not have today. For
a single-user local host this is near-trivial (one implicit user) but the
*shape* must exist so later phases have an owner to attach to.

Effort: low. Risk: low. This is the recommended first step and unblocks
everything.

### Phase C1 — Pessimistic locking on documents (cheapest viable, part 1)

What: host-owned locks with TTL/heartbeat/takeover (section 3). Editor mounts
read-only when locked by another; "Editing by X" banner; request-edit/handoff.
Agent takes/respects locks for prose writes.

Trade-off / give up: no simultaneous typing in one document. Markdown stays
source of truth — no source-of-truth shift, which is exactly why this is cheap.
Must add a lock registry to the host and lock checks to the SFTP save path and
the agent's prose-edit interface.

Effort: medium. Risk: low-medium (stale-lock takeover and unsaved-buffer recovery
are the fiddly parts).

### Phase C2 — Synced shared-state stores: kanban, annotation log (cheapest viable, part 2)

What: make the kanban/session store and the annotation log multi-client by
broadcasting writes from the host and resolving with last-writer-wins per field
(both are id-keyed, low-contention). Retrofit the relevant `host.vault`
namespaces from local blobs into sync-broadcasting stores.

Trade-off / give up: rare same-field races resolve by last-writer-wins (mild,
acceptable for board moves and annotation status). Requires the host to fan out
vault writes to subscribers — a real but small change to the vault store.

Effort: low-medium. Risk: low. At the end of C0-C2 Orden is genuinely
collaborative for the common cases: shared board, shared annotations, see-who's-here,
no-clobber documents.

### Phase C3 — Session co-watch and co-drive

What: co-watch is multiple WebSocket subscribers to one pty/transcript
(read-only fan-out, cheap). Co-drive is single-driver-with-handoff, reusing the
C1 lock primitive applied to the pty (a "driver lock").

Trade-off / give up: co-drive deliberately allows only one input stream at a
time; turn-taking and queue models are not built. Reuses locking, so little new
machinery.

Effort: co-watch low, co-drive medium. Risk: low-medium.

### Phase C4 — CRDT documents (full real-time, optional)

What: introduce Yjs plus y-prosemirror for documents that need true co-editing.
Yjs becomes the live source of truth for those documents; markdown becomes
serialization (serialize on save and for the agent's I/O). Persist the Yjs doc in
the vault. Keep presence (now via y-prosemirror awareness, replacing the hard
lock for these docs). Bridge the agent: prefer the live-collaborator edit
interface; fall back to a file-diff-to-CRDT bridge.

Trade-off / give up: the big one — source-of-truth shift for collaborative docs.
Cold-start re-anchoring of annotations changes (the doc is a CRDT, not a reloaded
markdown file); the SFTP save path becomes a serialization step, not the truth.
Markdown round-trip fidelity (already the named editor risk) now also gates CRDT
serialization. The agent reconciliation against a live CRDT is the subtlest piece.

Effort: high. Risk: high. Only undertake if simultaneous typing in one prose
document is a demonstrated need.

### What each path costs, summarized

- Cheapest viable (C0 to C3): locking plus presence plus synced shared state plus
  session co-watch/co-drive. No source-of-truth shift, no CRDT, markdown stays
  truth, ProseMirror untouched. Delivers the collaboration most users actually
  ask for. Aggregate effort low-to-medium, risk low-to-medium.

- Full real-time (add C4): CRDT documents on top. Source-of-truth shift,
  re-anchoring rework, agent-to-CRDT bridge. High effort, high risk. Reuses the
  presence and identity from C0; nothing earlier is wasted.

## 6. Recommendation

Build the cheapest-viable path (C0 to C3) and defer CRDT (C4) until simultaneous
typing in a single prose document is a proven, requested need rather than an
assumed one.

Rationale:

- Locking plus presence matches what users coming from check-out tools expect and
  delivers the no-clobber, see-who's-here value immediately.
- It requires no source-of-truth shift: markdown stays truth, ProseMirror is
  untouched, the SFTP save path and the agent's file workflow survive. That keeps
  the retrofit against today's codebase low.
- The agent integrates almost for free — it reuses the same lock primitive as
  humans for prose, and stays on files in a worktree for code, exactly matching
  the proposed split.
- Kanban and the annotation log are shared *state*, not shared text, and go
  collaborative cheaply with a synced store — most of Orden becomes collaborative
  without anyone touching the hard document case.
- Nothing built here is wasted if CRDT is added later: identity, presence, and the
  synced stores all survive; only the hard document lock is relaxed where Yjs
  takes over, and y-prosemirror's awareness protocol reuses the presence work.
- CRDT is the correct full-real-time target when it is needed (the design doc is
  right that ProseMirror keeps that door open), but it carries the source-of-truth
  shift and the agent-to-CRDT reconciliation — real cost that should be paid only
  against a real requirement.

### Recommended first step

Phase C0: add the identity and presence layer. It is low effort, low risk,
useful on its own (remote cursors and "who's here"), and a hard prerequisite for
every other phase — locks need an owner, co-drive needs a driver, CRDT awareness
needs identities. Do it after the host-backend refactor lands so the stores are
already behind the `Host` interface and there is a real per-connection identity
to attach to.
