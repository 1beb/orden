import { describe, it, expect } from "vitest";
import {
  LIFECYCLE_ORDER,
  buildBoard,
  needsActionCount,
  isNeedsAction,
} from "../src/kanban";
import type { Card } from "../src/types";

const cards: Card[] = [
  { id: "1", title: "alpha", state: "todo" },
  { id: "2", title: "beta", state: "in-progress" },
  { id: "3", title: "gamma", state: "blocked" },
  { id: "4", title: "delta", state: "ready" },
  { id: "5", title: "epsilon", state: "ready" },
  { id: "6", title: "zeta", state: "broken" },
  { id: "7", title: "eta", state: "complete" },
];

describe("LIFECYCLE_ORDER", () => {
  it("matches the design doc order, with broken last", () => {
    expect(LIFECYCLE_ORDER).toEqual([
      "backlog",
      "todo",
      "in-progress",
      "blocked",
      "ready",
      "complete",
      "broken",
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
    const ready = board.find((c) => c.state === "ready")!;
    expect(ready.cards.map((c) => c.id)).toEqual(["4", "5"]);
    const backlog = board.find((c) => c.state === "backlog")!;
    expect(backlog.cards).toEqual([]);
  });

  it("preserves input order within a column", () => {
    const board = buildBoard([
      { id: "b", title: "b", state: "todo" },
      { id: "a", title: "a", state: "todo" },
    ]);
    const todo = board.find((c) => c.state === "todo")!;
    expect(todo.cards.map((c) => c.id)).toEqual(["b", "a"]);
  });
});

describe("needs-action badge", () => {
  it("isNeedsAction is true only for blocked, ready, broken", () => {
    expect(isNeedsAction("blocked")).toBe(true);
    expect(isNeedsAction("ready")).toBe(true);
    expect(isNeedsAction("broken")).toBe(true);
    expect(isNeedsAction("todo")).toBe(false);
    expect(isNeedsAction("complete")).toBe(false);
    expect(isNeedsAction("in-progress")).toBe(false);
  });

  it("counts cards in needs-action states", () => {
    // blocked(1) + ready(2) + broken(1) = 4
    expect(needsActionCount(cards)).toBe(4);
  });

  it("is zero with no actionable cards", () => {
    expect(
      needsActionCount([{ id: "x", title: "x", state: "todo" }]),
    ).toBe(0);
  });
});
