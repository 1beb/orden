import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BrowserHost } from "../src/host/browserHost";
import { hydrateCards, listItems, setItemState, cardSessionIds, type Item } from "../src/cards";
import { hydrateSessions, createSession } from "../src/sessions";
import { openCardModal } from "../src/cardModal";

// Find the card a session was linked to (createSession drops a linked card).
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

describe("card modal — resume affordance", () => {
  beforeEach(async () => {
    localStorage.clear();
    const host = new BrowserHost();
    await hydrateCards(host);
    await hydrateSessions(host);
  });

  afterEach(() => {
    document.querySelectorAll(".card-modal-overlay").forEach((n) => n.remove());
  });

  it("offers a Resume button per linked session that opens that session", () => {
    const s = createSession({ title: "Fix the thing", agent: "claude", projectId: "p1" });
    const card = cardFor(s.id);
    setItemState(card.id, "complete");

    const opened: string[] = [];
    openCardModal(card.id, {
      onStartSession: () => {},
      onOpenSession: (id) => opened.push(id),
      onChange: () => {},
    });

    const resume = buttonByText(document.body, "Resume");
    expect(resume).toBeDefined();
    resume!.click();
    expect(opened).toEqual([s.id]);
  });
});
