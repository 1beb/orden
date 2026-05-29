/** Session lifecycle states, per the Orden design doc. */
export type LifecycleState =
  | "backlog"
  | "todo"
  | "in-progress"
  | "blocked"
  | "ready"
  | "complete";

/**
 * "broken" is an error state (the hosting process crashed). It is not a normal
 * lifecycle transition, so it lives outside LifecycleState but still feeds the
 * Kanban board and the needs-action badge.
 */
export type CardState = LifecycleState | "broken";

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
