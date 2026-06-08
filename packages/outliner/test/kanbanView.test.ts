// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { renderBoard } from "../src/kanbanView";
import type { Card } from "../src/types";

const cards: Card[] = [
  { id: "1", title: "alpha", state: "planning" },
  { id: "2", title: "beta", state: "blocked" },
  { id: "3", title: "gamma", state: "blocked" },
  { id: "4", title: "delta", state: "complete" },
];

describe("renderBoard", () => {
  it("renders one column per lifecycle state in order", () => {
    const host = document.createElement("div");
    renderBoard(host, cards);
    const states = Array.from(
      host.querySelectorAll<HTMLElement>(".orden-column"),
    ).map((el) => el.dataset.state);
    expect(states).toEqual([
      "planning",
      "in-progress",
      "blocked",
      "complete",
      "learnings",
    ]);
  });

  it("renders a capitalized column title", () => {
    const host = document.createElement("div");
    renderBoard(host, cards);
    const inProgress = host.querySelector<HTMLElement>(
      '[data-state="in-progress"]',
    )!;
    expect(
      inProgress.querySelector(".orden-column__title")!.textContent,
    ).toBe("In-progress");
  });

  it("shows a per-column count", () => {
    const host = document.createElement("div");
    renderBoard(host, cards);
    const blocked = host.querySelector<HTMLElement>('[data-state="blocked"]')!;
    expect(blocked.querySelector(".orden-column__count")!.textContent).toBe("2");
  });

  it("renders cards as list items with titles", () => {
    const host = document.createElement("div");
    renderBoard(host, cards);
    const blocked = host.querySelector<HTMLElement>('[data-state="blocked"]')!;
    const titles = Array.from(
      blocked.querySelectorAll(".orden-card"),
    ).map((el) => el.textContent);
    expect(titles).toEqual(["beta", "gamma"]);
  });

  it("computes the needs-action badge (blocked 2 = 2)", () => {
    const host = document.createElement("div");
    renderBoard(host, cards);
    const badge = host.querySelector<HTMLElement>(".orden-board__needs-action")!;
    expect(badge.dataset.count).toBe("2");
  });

  it("flags needs-action columns with a modifier class", () => {
    const host = document.createElement("div");
    renderBoard(host, cards);
    const blocked = host.querySelector<HTMLElement>('[data-state="blocked"]')!;
    const planning = host.querySelector<HTMLElement>('[data-state="planning"]')!;
    expect(blocked.classList.contains("orden-column--action")).toBe(true);
    expect(planning.classList.contains("orden-column--action")).toBe(false);
  });

  it("clears prior content on re-render", () => {
    const host = document.createElement("div");
    renderBoard(host, cards);
    renderBoard(host, [{ id: "x", title: "solo", state: "planning" }]);
    expect(host.querySelectorAll(".orden-board__header").length).toBe(1);
    expect(host.querySelectorAll(".orden-card").length).toBe(1);
  });
});
