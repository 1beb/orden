import type { Card, CardState, Column } from "./types";

/**
 * Column order on the board, left to right. The first four are real lifecycle
 * states; the rightmost, `"learnings"`, is a DERIVED column id (no card is ever
 * stored in state "learnings" — a complete card with pending learnings buckets
 * there at render time). See `LifecycleState`.
 */
export const LIFECYCLE_ORDER: readonly CardState[] = [
  "planning",
  "in-progress",
  "blocked",
  "complete",
  "learnings",
];

/** States that need the user's attention and feed the Kanban badge. */
export const NEEDS_ACTION_STATES: readonly CardState[] = ["blocked"];

export function isNeedsAction(state: CardState): boolean {
  return NEEDS_ACTION_STATES.includes(state);
}

/** Default dwell time before a completed card drops off the board/list. */
export const COMPLETE_TTL_MS = 60 * 60 * 1000;

/**
 * True once a completed card has aged past its TTL and should fall off the
 * view. Non-complete cards never expire. A complete card with no completedAt
 * (stamped before that field existed) is treated as already past its TTL.
 * `ttlMs` lets callers override the dwell time (a user setting); it defaults
 * to COMPLETE_TTL_MS.
 */
export function isExpiredComplete(
  card: { state: CardState; completedAt?: number },
  nowMs: number,
  ttlMs: number = COMPLETE_TTL_MS,
): boolean {
  if (card.state !== "complete") return false;
  const age =
    typeof card.completedAt === "number" ? nowMs - card.completedAt : Infinity;
  return age >= ttlMs;
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
