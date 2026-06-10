# ADR-0007: Collaboration — pessimistic locking first, CRDT deferred

**Date:** 2026-05-29
**Status:** accepted

## Context

Orden is designed to be multi-user, but the collaboration surface spans several
concerns with different needs: document co-editing (hard, needs convergence math),
shared kanban/annotation state (easy, key-value sync), session co-watch/co-drive
(needs arbitration), and identity/presence (prerequisite for everything).

## Decision

**Build the cheapest-viable collaboration path first (pessimistic locking + shared
stores) and defer CRDT (Yjs + y-prosemirror) until simultaneous typing in one
prose document is a proven need.**

Phase order:

1. **C0 — Identity and presence** (prerequisite). Add user identity per connection
   and presence broadcast (who is connected, what resource each has open).
2. **C1 — Pessimistic document locking.** Host-owned locks with TTL/heartbeat/
   stale-lock takeover. Editor mounts read-only when locked by another. Agent
   takes/respects locks for prose writes.
3. **C2 — Synced shared-state stores.** Kanban/session store and annotation log
   become multi-client via broadcast writes with last-writer-wins per field (both
   are id-keyed, low-contention).
4. **C3 — Session co-watch and co-drive.** Co-watch = multiple WebSocket
   subscribers to one pty (read-only fan-out). Co-drive = single-driver-with-
   handoff, reusing the C1 lock primitive applied to the pty.
5. **C4 (DEFERRED) — CRDT documents.** Yjs + y-prosemirror for true co-editing.
   Live source of truth shifts from markdown files to Yjs document; markdown
   becomes serialization. Only undertake if simultaneous typing in one prose doc
   is a proven need.

Key architectural constraint: nothing built for locking-plus-presence is wasted by
a later CRDT. Identity, presence, and synced stores all survive the migration; only
the hard document lock is relaxed where Yjs takes over.

**Rejected alternatives:**

- **Optimistic presence only (no locking).** Shows who's here but does nothing to
  prevent concurrent edits — last writer wins, silently losing data. For a tool
  where "Save, then the agent reacts now" is the premise, a clobbered save
  corrupts the review loop quietly. This is the worst option.
- **Operational Transform (OT, e.g. ShareDB).** Demands an always-on
  authoritative server (poor fit for local-first), and the agent must emit
  transformable operations rather than write files — a large retrofit.
- **CRDT from day one.** The source-of-truth shift and agent-to-CRDT
  reconciliation are real costs. Paying them up front for a feature (simultaneous
  typing) that may never be needed is premature.
- **Naive (manual merge / git conflicts).** Already rejected for the
  transactional review path: eventual consistency and conflict files break "Save,
  then the agent reacts now."

## Consequences

**Easier:**

- The document and agent models stay simple — markdown is truth, ProseMirror is
  untouched, the agent's file-based workflow survives.
- Kanban and annotations go collaborative cheaply (they're shared state, not
  shared text).
- Users get the no-clobber, see-who's-here value immediately.

**Harder:**

- `Host` carries `identity` and `locks` from the start (single-user no-ops until
  wired), adding surface area before it's used.
- Stale-lock takeover and unsaved-buffer recovery are fiddly edge cases that must
  be handled correctly.
- The eventual CRDT migration, if it happens, requires rethinking cold-start
  re-anchoring (the doc is now a CRDT, not a reloaded markdown file).
