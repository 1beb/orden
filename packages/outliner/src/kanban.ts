import type { Card, CardState, Column } from "./types";

/** Column order on the board: the four lifecycle states. */
export const LIFECYCLE_ORDER: readonly CardState[] = [
  "planning",
  "in-progress",
  "blocked",
  "complete",
];

/** States that need the user's attention and feed the Kanban badge. */
export const NEEDS_ACTION_STATES: readonly CardState[] = ["blocked"];

export function isNeedsAction(state: CardState): boolean {
  return NEEDS_ACTION_STATES.includes(state);
}

/** Group cards into one column per state, in lifecycle order. */
export function buildBoard(cards: Card[]): Column[] {
  return LIFECYCLE_ORDER.map((state) => ({
    state,
    cards: cards.filter((c) => c.state === state),
  }));
}

/** Count of cards in a needs-action state (the left-nav badge number). */
export function needsActionCount(cards: Card[]): number {
  return cards.filter((c) => isNeedsAction(c.state)).length;
}
