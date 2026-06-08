import { beforeEach, describe, expect, it } from "vitest";
import { BrowserHost } from "../src/host/browserHost";
import { hydrateCards, listItems, setItemState, cardSessionIds, type Item } from "../src/cards";
import { hydrateSessions, createSession } from "../src/sessions";
import { renderKanban } from "../src/kanban";

function cardFor(sessionId: string): Item {
  const item = listItems().find((i) => cardSessionIds(i).includes(sessionId));
  if (!item) throw new Error("no card for session");
  return item;
}

// The column an item's card was rendered into, by its data-state attribute.
function columnOf(root: ParentNode, itemId: string): string | undefined {
  const card = root.querySelector<HTMLElement>(`.orden-card[data-item-id="${itemId}"]`);
  return card?.closest<HTMLElement>(".orden-column")?.dataset.state;
}

function columnEl(root: ParentNode, state: string): HTMLElement {
  const el = root.querySelector<HTMLElement>(`.orden-column[data-state="${state}"]`);
  if (!el) throw new Error(`no column for ${state}`);
  return el;
}

// Fire a drag-drop of itemId onto the given column element, the way the board's
// drop handler reads it (the card id off dataTransfer's "text/plain").
function dropOnto(col: HTMLElement, itemId: string): void {
  const dt = { getData: (k: string) => (k === "text/plain" ? itemId : "") };
  const ev = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "dataTransfer", { value: dt });
  col.dispatchEvent(ev);
}

describe("kanban card — resume affordance", () => {
  beforeEach(async () => {
    localStorage.clear();
    const host = new BrowserHost();
    await hydrateCards(host);
    await hydrateSessions(host);
  });

  it("renders a Resume button on a card with a session that opens it", () => {
    const s = createSession({ title: "Do work", agent: "claude", projectId: "p1" });
    const card = cardFor(s.id);
    setItemState(card.id, "complete");

    const container = document.createElement("div");
    const opened: string[] = [];
    renderKanban(container, {
      onStartSession: () => {},
      onOpenSession: (id) => opened.push(id),
      onOpenLearnings: () => {},
      pendingLearnings: () => 0,
    });

    // The Resume affordance is an icon-only button (SVG + aria-label, no visible
    // text), so locate it by its class rather than text.
    const resume = container.querySelector<HTMLButtonElement>(".orden-card__resume");
    expect(resume).not.toBeNull();
    resume!.click();
    expect(opened).toEqual([s.id]);
  });
});

describe("kanban — derived Learnings column", () => {
  beforeEach(async () => {
    localStorage.clear();
    const host = new BrowserHost();
    await hydrateCards(host);
    await hydrateSessions(host);
  });

  it("buckets a complete card with pending learnings under Learnings, not Complete", () => {
    const s = createSession({ title: "Do work", agent: "claude", projectId: "p1" });
    const card = cardFor(s.id);
    setItemState(card.id, "complete");

    const container = document.createElement("div");
    renderKanban(container, {
      onStartSession: () => {},
      onOpenSession: () => {},
      onOpenLearnings: () => {},
      pendingLearnings: () => 1,
    });

    expect(columnOf(container, card.id)).toBe("learnings");
  });

  it("buckets a complete card with no pending learnings under Complete", () => {
    const s = createSession({ title: "Do work", agent: "claude", projectId: "p1" });
    const card = cardFor(s.id);
    setItemState(card.id, "complete");

    const container = document.createElement("div");
    renderKanban(container, {
      onStartSession: () => {},
      onOpenSession: () => {},
      onOpenLearnings: () => {},
      pendingLearnings: () => 0,
    });

    expect(columnOf(container, card.id)).toBe("complete");
  });

  it("counts a blocked card in the returned needs-action total", () => {
    const s = createSession({ title: "Do work", agent: "claude", projectId: "p1" });
    const card = cardFor(s.id);
    setItemState(card.id, "blocked");

    const container = document.createElement("div");
    const needs = renderKanban(container, {
      onStartSession: () => {},
      onOpenSession: () => {},
      onOpenLearnings: () => {},
      pendingLearnings: () => 0,
    });

    expect(needs).toBe(1);
  });

  it("counts a complete card with pending learnings in the returned needs total", () => {
    const s = createSession({ title: "Do work", agent: "claude", projectId: "p1" });
    const card = cardFor(s.id);
    setItemState(card.id, "complete");

    const container = document.createElement("div");
    const needs = renderKanban(container, {
      onStartSession: () => {},
      onOpenSession: () => {},
      onOpenLearnings: () => {},
      pendingLearnings: () => 1,
    });

    expect(needs).toBe(1);
  });

  it("does not count a complete card with no pending learnings", () => {
    const s = createSession({ title: "Do work", agent: "claude", projectId: "p1" });
    const card = cardFor(s.id);
    setItemState(card.id, "complete");

    const container = document.createElement("div");
    const needs = renderKanban(container, {
      onStartSession: () => {},
      onOpenSession: () => {},
      onOpenLearnings: () => {},
      pendingLearnings: () => 0,
    });

    expect(needs).toBe(0);
  });

  it("counts both a blocked card and a complete-with-pending card", () => {
    const blocked = createSession({ title: "Blocked work", agent: "claude", projectId: "p1" });
    setItemState(cardFor(blocked.id).id, "blocked");
    const done = createSession({ title: "Done work", agent: "claude", projectId: "p1" });
    const doneCard = cardFor(done.id);
    setItemState(doneCard.id, "complete");

    const container = document.createElement("div");
    const needs = renderKanban(container, {
      onStartSession: () => {},
      onOpenSession: () => {},
      onOpenLearnings: () => {},
      pendingLearnings: (id) => (id === doneCard.id ? 1 : 0),
    });

    expect(needs).toBe(2);
  });

  it("opens the learnings view (not the card modal) when a Learnings-column card is clicked", () => {
    const s = createSession({ title: "Do work", agent: "claude", projectId: "p1" });
    const card = cardFor(s.id);
    setItemState(card.id, "complete");

    const container = document.createElement("div");
    const openedLearnings: string[] = [];
    renderKanban(container, {
      onStartSession: () => {},
      onOpenSession: () => {},
      onOpenLearnings: (id) => openedLearnings.push(id),
      pendingLearnings: () => 1,
    });

    const cardEl = container.querySelector<HTMLElement>(
      `.orden-card[data-item-id="${card.id}"]`,
    );
    expect(cardEl).toBeTruthy();
    // No card modal should be mounted by this click — assert the learnings dep fired.
    cardEl!.click();
    expect(openedLearnings).toEqual([card.id]);
    expect(document.querySelector(".card-modal")).toBeNull();
  });

  it("does not call onOpenLearnings for a normal-column card click", () => {
    const s = createSession({ title: "Do work", agent: "claude", projectId: "p1" });
    const card = cardFor(s.id);
    setItemState(card.id, "blocked");

    const container = document.createElement("div");
    const openedLearnings: string[] = [];
    renderKanban(container, {
      onStartSession: () => {},
      onOpenSession: () => {},
      onOpenLearnings: (id) => openedLearnings.push(id),
      pendingLearnings: () => 0,
    });

    const cardEl = container.querySelector<HTMLElement>(
      `.orden-card[data-item-id="${card.id}"]`,
    );
    expect(cardEl).toBeTruthy();
    cardEl!.click();
    // Normal cards take the existing modal path, never the learnings path.
    expect(openedLearnings).toEqual([]);
  });

  it("rejects a drop onto Learnings — a card can't be parked there via the board", () => {
    const s = createSession({ title: "Do work", agent: "claude", projectId: "p1" });
    const card = cardFor(s.id);
    setItemState(card.id, "blocked");

    const container = document.createElement("div");
    renderKanban(container, {
      onStartSession: () => {},
      onOpenSession: () => {},
      onOpenLearnings: () => {},
      pendingLearnings: () => 0,
    });

    // Sanity: real columns DO accept drops (proves the harness fires the handler).
    dropOnto(columnEl(container, "complete"), card.id);
    expect(listItems().find((i) => i.id === card.id)?.state).toBe("complete");

    setItemState(card.id, "blocked");
    const c2 = document.createElement("div");
    renderKanban(c2, {
      onStartSession: () => {},
      onOpenSession: () => {},
      onOpenLearnings: () => {},
      pendingLearnings: () => 0,
    });

    // Dropping onto Learnings is a no-op: the column wires no drop handler, so
    // the card's state is never set to "learnings" (and never could be — it's
    // not a CardState).
    dropOnto(columnEl(c2, "learnings"), card.id);
    expect(listItems().find((i) => i.id === card.id)?.state).toBe("blocked");
  });
});
