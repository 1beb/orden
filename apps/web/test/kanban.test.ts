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

function buttonByText(root: ParentNode, text: string): HTMLButtonElement | undefined {
  return [...root.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent?.trim() === text,
  );
}

// The column an item's card was rendered into, by its data-state attribute.
function columnOf(root: ParentNode, itemId: string): string | undefined {
  const card = root.querySelector<HTMLElement>(`.orden-card[data-item-id="${itemId}"]`);
  return card?.closest<HTMLElement>(".orden-column")?.dataset.state;
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
      pendingLearnings: () => 0,
    });

    const resume = buttonByText(container, "Resume");
    expect(resume).toBeDefined();
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
      pendingLearnings: () => 0,
    });

    expect(columnOf(container, card.id)).toBe("complete");
  });
});
