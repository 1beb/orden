import { describe, it, expect } from "vitest";
import { buildBoard } from "../src/kanban";
import type { Card } from "../src/types";

// The board is now generic over the lane key — no lane set is baked in. The
// caller supplies the order. (The orden-specific constants that used to live
// here — LIFECYCLE_ORDER, NEEDS_ACTION_STATES, COMPLETE_TTL_MS, isExpiredComplete
// — moved to @orden/host-api. See docs/plans/2026-06-19-on-hold-and-lifecycle-config.md.)

const STATES = ["planning", "in-progress", "blocked", "complete"] as const;
type S = (typeof STATES)[number];

const cards: Card<S>[] = [
  { id: "1", title: "alpha", state: "planning" },
  { id: "2", title: "beta", state: "in-progress" },
  { id: "3", title: "gamma", state: "blocked" },
  { id: "4", title: "delta", state: "blocked" },
  { id: "5", title: "epsilon", state: "complete" },
  { id: "6", title: "zeta", state: "complete" },
  { id: "7", title: "eta", state: "planning" },
];

describe("buildBoard", () => {
  it("creates one column per supplied state, in the given order", () => {
    const board = buildBoard(cards, STATES);
    expect(board.map((c) => c.state)).toEqual([...STATES]);
  });

  it("groups cards into the right columns", () => {
    const board = buildBoard(cards, STATES);
    const blocked = board.find((c) => c.state === "blocked")!;
    expect(blocked.cards.map((c) => c.id)).toEqual(["3", "4"]);
    const inProgress = board.find((c) => c.state === "in-progress")!;
    expect(inProgress.cards.map((c) => c.id)).toEqual(["2"]);
  });

  it("preserves input order within a column", () => {
    const board = buildBoard(
      [
        { id: "b", title: "b", state: "planning" },
        { id: "a", title: "a", state: "planning" },
      ] as Card<S>[],
      STATES,
    );
    const planning = board.find((c) => c.state === "planning")!;
    expect(planning.cards.map((c) => c.id)).toEqual(["b", "a"]);
  });

  it("omits a column when no cards match and the caller didn't list it", () => {
    // The caller controls the column set: an unlisted state simply has no column.
    const board = buildBoard(cards, ["planning", "complete"]);
    expect(board.map((c) => c.state)).toEqual(["planning", "complete"]);
    expect(board.find((c) => c.state === "planning")!.cards).toHaveLength(2);
  });
});
