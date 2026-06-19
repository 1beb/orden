// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { renderBoard } from "../src/kanbanView";
import type { Card } from "../src/types";

// The board renderer is generic over the lane key. A toy config drives it here;
// orden passes its LifecycleConfig (states/labels/actionStates) at the call site.
const STATES = ["planning", "in-progress", "blocked", "complete"] as const;
type S = (typeof STATES)[number];
const LABELS: Record<S, string> = {
  planning: "Planning",
  "in-progress": "In-progress",
  blocked: "Blocked",
  complete: "Complete",
};

const cards: Card<S>[] = [
  { id: "1", title: "alpha", state: "planning" },
  { id: "2", title: "beta", state: "blocked" },
  { id: "3", title: "gamma", state: "blocked" },
  { id: "4", title: "delta", state: "complete" },
];

const opts = { states: STATES, labels: LABELS, actionStates: ["blocked"] as const };

describe("renderBoard", () => {
  it("renders one column per supplied state in order", () => {
    const host = document.createElement("div");
    renderBoard(host, cards, opts);
    const states = Array.from(
      host.querySelectorAll<HTMLElement>(".orden-column"),
    ).map((el) => el.dataset.state);
    expect(states).toEqual([
      "planning",
      "in-progress",
      "blocked",
      "complete",
    ]);
  });

  it("renders the supplied column label", () => {
    const host = document.createElement("div");
    renderBoard(host, cards, opts);
    const inProgress = host.querySelector<HTMLElement>(
      '[data-state="in-progress"]',
    )!;
    expect(
      inProgress.querySelector(".orden-column__title")!.textContent,
    ).toBe("In-progress");
  });

  it("shows a per-column count", () => {
    const host = document.createElement("div");
    renderBoard(host, cards, opts);
    const blocked = host.querySelector<HTMLElement>('[data-state="blocked"]')!;
    expect(blocked.querySelector(".orden-column__count")!.textContent).toBe("2");
  });

  it("renders cards as list items with titles", () => {
    const host = document.createElement("div");
    renderBoard(host, cards, opts);
    const blocked = host.querySelector<HTMLElement>('[data-state="blocked"]')!;
    const titles = Array.from(
      blocked.querySelectorAll(".orden-card"),
    ).map((el) => el.textContent);
    expect(titles).toEqual(["beta", "gamma"]);
  });

  it("computes the needs-action badge from actionStates (blocked 2 = 2)", () => {
    const host = document.createElement("div");
    renderBoard(host, cards, opts);
    const badge = host.querySelector<HTMLElement>(".orden-board__needs-action")!;
    expect(badge.dataset.count).toBe("2");
  });

  it("omits the needs-action badge when no card is in an action lane", () => {
    const host = document.createElement("div");
    renderBoard(host, [{ id: "x", title: "solo", state: "planning" }], opts);
    expect(host.querySelector(".orden-board__needs-action")).toBeNull();
  });

  it("flags needs-action columns with a modifier class", () => {
    const host = document.createElement("div");
    renderBoard(host, cards, opts);
    const blocked = host.querySelector<HTMLElement>('[data-state="blocked"]')!;
    const planning = host.querySelector<HTMLElement>('[data-state="planning"]')!;
    expect(blocked.classList.contains("orden-column--action")).toBe(true);
    expect(planning.classList.contains("orden-column--action")).toBe(false);
  });

  it("clears prior content on re-render", () => {
    const host = document.createElement("div");
    renderBoard(host, cards, opts);
    renderBoard(host, [{ id: "x", title: "solo", state: "planning" }], opts);
    expect(host.querySelectorAll(".orden-board__header").length).toBe(1);
    expect(host.querySelectorAll(".orden-card").length).toBe(1);
  });
});
