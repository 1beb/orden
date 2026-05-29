// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { renderBoard } from "../src/kanbanView";
import type { Card } from "../src/types";

const cards: Card[] = [
  { id: "1", title: "alpha", state: "todo" },
  { id: "2", title: "beta", state: "ready" },
  { id: "3", title: "gamma", state: "ready" },
  { id: "4", title: "delta", state: "broken" },
];

describe("renderBoard", () => {
  it("renders one column per lifecycle state in order", () => {
    const host = document.createElement("div");
    renderBoard(host, cards);
    const states = Array.from(
      host.querySelectorAll<HTMLElement>(".orden-column"),
    ).map((el) => el.dataset.state);
    expect(states).toEqual([
      "backlog",
      "todo",
      "in-progress",
      "blocked",
      "ready",
      "complete",
      "broken",
    ]);
  });

  it("shows a per-column count", () => {
    const host = document.createElement("div");
    renderBoard(host, cards);
    const ready = host.querySelector<HTMLElement>('[data-state="ready"]')!;
    expect(ready.querySelector(".orden-column__count")!.textContent).toBe("2");
  });

  it("renders cards as list items with titles", () => {
    const host = document.createElement("div");
    renderBoard(host, cards);
    const ready = host.querySelector<HTMLElement>('[data-state="ready"]')!;
    const titles = Array.from(
      ready.querySelectorAll(".orden-card"),
    ).map((el) => el.textContent);
    expect(titles).toEqual(["beta", "gamma"]);
  });

  it("computes the needs-action badge (ready 2 + broken 1 = 3)", () => {
    const host = document.createElement("div");
    renderBoard(host, cards);
    const badge = host.querySelector<HTMLElement>(".orden-board__needs-action")!;
    expect(badge.dataset.count).toBe("3");
  });

  it("flags needs-action columns with a modifier class", () => {
    const host = document.createElement("div");
    renderBoard(host, cards);
    const ready = host.querySelector<HTMLElement>('[data-state="ready"]')!;
    const todo = host.querySelector<HTMLElement>('[data-state="todo"]')!;
    expect(ready.classList.contains("orden-column--action")).toBe(true);
    expect(todo.classList.contains("orden-column--action")).toBe(false);
  });

  it("clears prior content on re-render", () => {
    const host = document.createElement("div");
    renderBoard(host, cards);
    renderBoard(host, [{ id: "x", title: "solo", state: "todo" }]);
    expect(host.querySelectorAll(".orden-board__header").length).toBe(1);
    expect(host.querySelectorAll(".orden-card").length).toBe(1);
  });
});
