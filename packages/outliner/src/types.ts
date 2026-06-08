/** Session lifecycle states. The four columns on the Kanban board. */
export type LifecycleState =
  | "planning"
  | "in-progress"
  | "blocked"
  | "complete";

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
