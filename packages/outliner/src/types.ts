/**
 * Session lifecycle states plus the derived board columns.
 *
 * The first four are real, stored card states. `"learnings"` is NOT a stored
 * state — it is a render-only COLUMN id. A card's `state` is never literally
 * `"learnings"`; instead a `complete` card with pending learnings is *bucketed*
 * into the Learnings column at render time (and falls back to Complete once it
 * has none). It lives in this union only so column-iteration and the per-column
 * label `Record`s stay exhaustive.
 */
export type LifecycleState =
  | "planning"
  | "in-progress"
  | "blocked"
  | "complete"
  | "learnings";

/**
 * A card's state is exactly its lifecycle state. Kept as an alias so existing
 * call sites that reference `CardState` keep working.
 */
export type CardState = LifecycleState;

/** A single bullet in the outline. */
export interface Block {
  id: string;
  text: string;
  collapsed: boolean;
  children: Block[];
}

/** A named outline. The daily journal is just pages keyed by an ISO date. */
export interface Page {
  /** Stable key. For journal pages this is an ISO date, e.g. "2026-05-28". */
  name: string;
  root: Block;
}

/** A Kanban card derived from a stateful item (a Session projection). */
export interface Card {
  id: string;
  title: string;
  state: CardState;
}

/** A column on the board: one CardState plus its cards. */
export interface Column {
  state: CardState;
  cards: Card[];
}
