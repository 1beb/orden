import { describe, it, expect } from "vitest";
import {
  LIFECYCLE_ORDER,
  buildBoard,
  needsActionCount,
  isNeedsAction,
} from "../src/kanban";
import type { Card } from "../src/types";

const cards: Card[] = [
  { id: "1", title: "alpha", state: "planning" },
  { id: "2", title: "beta", state: "in-progress" },
  { id: "3", title: "gamma", state: "blocked" },
  { id: "4", title: "delta", state: "blocked" },
  { id: "5", title: "epsilon", state: "complete" },
  { id: "6", title: "zeta", state: "complete" },
  { id: "7", title: "eta", state: "planning" },
];

describe("LIFECYCLE_ORDER", () => {
  it("is the four lifecycle states in order", () => {
    expect(LIFECYCLE_ORDER).toEqual([
      "planning",
      "in-progress",
      "blocked",
      "complete",
    ]);
  });
});

describe("buildBoard", () => {
  it("creates one column per state, in lifecycle order", () => {
    const board = buildBoard(cards);
    expect(board.map((c) => c.state)).toEqual(LIFECYCLE_ORDER);
  });

  it("groups cards into the right columns", () => {
    const board = buildBoard(cards);
    const blocked = board.find((c) => c.state === "blocked")!;
    expect(blocked.cards.map((c) => c.id)).toEqual(["3", "4"]);
    const inProgress = board.find((c) => c.state === "in-progress")!;
    expect(inProgress.cards.map((c) => c.id)).toEqual(["2"]);
  });

  it("preserves input order within a column", () => {
    const board = buildBoard([
      { id: "b", title: "b", state: "planning" },
      { id: "a", title: "a", state: "planning" },
    ]);
    const planning = board.find((c) => c.state === "planning")!;
    expect(planning.cards.map((c) => c.id)).toEqual(["b", "a"]);
  });
});

describe("needs-action badge", () => {
  it("isNeedsAction is true only for blocked", () => {
    expect(isNeedsAction("blocked")).toBe(true);
    expect(isNeedsAction("planning")).toBe(false);
    expect(isNeedsAction("complete")).toBe(false);
    expect(isNeedsAction("in-progress")).toBe(false);
  });

  it("counts cards in needs-action states", () => {
    // blocked(2)
    expect(needsActionCount(cards)).toBe(2);
  });

  it("is zero with no actionable cards", () => {
    expect(
      needsActionCount([{ id: "x", title: "x", state: "planning" }]),
    ).toBe(0);
  });
});
