import { beforeEach, describe, expect, it } from "vitest";
import { BrowserHost } from "../src/host/browserHost";
import {
  hydrateCards,
  listItems,
  setItemState,
  cardSessionIds,
  getItem,
  type Item,
} from "../src/cards";
import { hydrateSessions, createSession } from "../src/sessions";
import { hydrateSettings, saveSettings } from "../src/settings";
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
      openLearnings: () => 0,
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
      openLearnings: () => 1,
    });

    expect(columnOf(container, card.id)).toBe("learnings");
  });

  it("buckets a complete card with no open learnings under Complete", () => {
    const s = createSession({ title: "Do work", agent: "claude", projectId: "p1" });
    const card = cardFor(s.id);
    setItemState(card.id, "complete");

    const container = document.createElement("div");
    renderKanban(container, {
      onStartSession: () => {},
      onOpenSession: () => {},
      onOpenLearnings: () => {},
      openLearnings: () => 0,
    });

    expect(columnOf(container, card.id)).toBe("complete");
  });

  it("buckets a complete card with only revising (open) learnings under Learnings and counts it", () => {
    const s = createSession({ title: "Do work", agent: "claude", projectId: "p1" });
    const card = cardFor(s.id);
    setItemState(card.id, "complete");

    const container = document.createElement("div");
    // openLearnings counts pending OR revising; a card whose only learning is
    // revising still reports >0, so it stays diverted to Learnings and counts.
    const needs = renderKanban(container, {
      onStartSession: () => {},
      onOpenSession: () => {},
      onOpenLearnings: () => {},
      openLearnings: () => 1,
    });

    expect(columnOf(container, card.id)).toBe("learnings");
    expect(needs).toBe(1);
  });

  it("buckets a complete card whose learnings are all resolved under Complete and does not count it", () => {
    const s = createSession({ title: "Do work", agent: "claude", projectId: "p1" });
    const card = cardFor(s.id);
    setItemState(card.id, "complete");

    const container = document.createElement("div");
    // All learnings accepted/rejected → openLearnings is 0 → falls back to Complete
    // and contributes nothing to the needs count.
    const needs = renderKanban(container, {
      onStartSession: () => {},
      onOpenSession: () => {},
      onOpenLearnings: () => {},
      openLearnings: () => 0,
    });

    expect(columnOf(container, card.id)).toBe("complete");
    expect(needs).toBe(0);
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
      openLearnings: () => 0,
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
      openLearnings: () => 1,
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
      openLearnings: () => 0,
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
      openLearnings: (id) => (id === doneCard.id ? 1 : 0),
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
      openLearnings: () => 1,
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
      openLearnings: () => 0,
    });

    const cardEl = container.querySelector<HTMLElement>(
      `.orden-card[data-item-id="${card.id}"]`,
    );
    expect(cardEl).toBeTruthy();
    cardEl!.click();
    // Normal cards take the existing modal path, never the learnings path.
    expect(openedLearnings).toEqual([]);
  });

  it("renders an integration-decision question + a chip per option and records the winner", () => {
    const s = createSession({ title: "Feature B", agent: "claude", projectId: "p1" });
    const card = cardFor(s.id);
    setItemState(card.id, "blocked");
    Object.assign(getItem(card.id)!, {
      mergeStatus: "blocked-intent",
      integrationBlock: {
        kind: "intent",
        question: "Feature B conflicts with Feature A — which goal wins?",
        options: [card.id, "other"],
        otherCardIds: ["other"],
      },
    });

    const container = document.createElement("div");
    renderKanban(container, {
      onStartSession: () => {},
      onOpenSession: () => {},
      onOpenLearnings: () => {},
      openLearnings: () => 0,
    });

    expect(container.querySelector(".orden-card__decision-q")?.textContent).toContain("which goal wins");
    const chips = container.querySelectorAll<HTMLButtonElement>(".orden-card__decision-chip");
    expect(chips.length).toBe(2);
    expect(chips[0].textContent).toBe("Feature B"); // option is this card id → its title

    chips[0].click();
    expect(getItem(card.id)?.integrationBlock?.chosen).toBe(card.id);
  });

  it("renders an unverifiable block's question with no chips", () => {
    const s = createSession({ title: "Feature C", agent: "claude", projectId: "p1" });
    const card = cardFor(s.id);
    setItemState(card.id, "blocked");
    Object.assign(getItem(card.id)!, {
      mergeStatus: "blocked-unverifiable",
      integrationBlock: { kind: "unverifiable", question: "Combined gate failed." },
    });

    const container = document.createElement("div");
    renderKanban(container, {
      onStartSession: () => {},
      onOpenSession: () => {},
      onOpenLearnings: () => {},
      openLearnings: () => 0,
    });

    expect(container.querySelector(".orden-card__decision-q")?.textContent).toContain("Combined gate failed");
    expect(container.querySelectorAll(".orden-card__decision-chip").length).toBe(0);
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
      openLearnings: () => 0,
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
      openLearnings: () => 0,
    });

    // Dropping onto Learnings is a no-op: the column wires no drop handler, so
    // the card's state is never set to "learnings" (and never could be — it's
    // not a CardState).
    dropOnto(columnEl(c2, "learnings"), card.id);
    expect(listItems().find((i) => i.id === card.id)?.state).toBe("blocked");
  });
});

describe("kanban list view — derived Learnings group", () => {
  const deps = (over: Partial<Parameters<typeof renderKanban>[1]> = {}) => ({
    onStartSession: () => {},
    onOpenSession: () => {},
    onOpenLearnings: () => {},
    openLearnings: () => 0,
    ...over,
  });

  // The .issue-group whose state pill carries data-state, for a given card title.
  function groupStateOf(root: ParentNode, title: string): string | undefined {
    const titleBtn = [...root.querySelectorAll<HTMLElement>(".issue-title")].find(
      (b) => b.textContent === title,
    );
    const group = titleBtn?.closest<HTMLElement>(".issue-group");
    return group?.querySelector<HTMLElement>(".issue-group-state")?.dataset.state;
  }

  beforeEach(async () => {
    localStorage.clear();
    const host = new BrowserHost();
    await hydrateCards(host);
    await hydrateSessions(host);
    await hydrateSettings(host); // reset settings cache to defaults (board)
    await saveSettings({ kanbanView: "list" });
  });

  it("buckets a complete card with open learnings under a Learnings group, not Complete", () => {
    const s = createSession({ title: "Do work", agent: "claude", projectId: "p1" });
    const card = cardFor(s.id);
    setItemState(card.id, "complete");

    const container = document.createElement("div");
    renderKanban(container, deps({ openLearnings: () => 1 }));

    expect(groupStateOf(container, "Do work")).toBe("learnings");
  });

  it("buckets a complete card with no open learnings under Complete", () => {
    const s = createSession({ title: "Do work", agent: "claude", projectId: "p1" });
    const card = cardFor(s.id);
    setItemState(card.id, "complete");

    const container = document.createElement("div");
    renderKanban(container, deps({ openLearnings: () => 0 }));

    expect(groupStateOf(container, "Do work")).toBe("complete");
  });

  it("opens the learnings review view (not the card modal) when a Learnings-group row is clicked", () => {
    const s = createSession({ title: "Do work", agent: "claude", projectId: "p1" });
    const card = cardFor(s.id);
    setItemState(card.id, "complete");

    const container = document.createElement("div");
    const opened: string[] = [];
    renderKanban(container, deps({ openLearnings: () => 1, onOpenLearnings: (id) => opened.push(id) }));

    const titleBtn = [...container.querySelectorAll<HTMLElement>(".issue-title")].find(
      (b) => b.textContent === "Do work",
    );
    expect(titleBtn).toBeTruthy();
    titleBtn!.click();
    // onOpenLearnings firing proves the row took the review path and returned
    // before the card-modal branch.
    expect(opened).toEqual([card.id]);
  });

  it("keeps a complete-with-learnings card visible even after its fade TTL has passed", () => {
    const s = createSession({ title: "Stale learnings", agent: "claude", projectId: "p1" });
    const card = cardFor(s.id);
    setItemState(card.id, "complete");
    // Age the completion well past any fade window — the board's Complete column
    // would drop this, but an open-learnings card must persist in the list.
    getItem(card.id)!.completedAt = 1;

    const container = document.createElement("div");
    renderKanban(container, deps({ openLearnings: () => 1 }));

    expect(groupStateOf(container, "Stale learnings")).toBe("learnings");
  });

  it("ages off a complete card with NO learnings once past its fade TTL", () => {
    const s = createSession({ title: "Stale done", agent: "claude", projectId: "p1" });
    const card = cardFor(s.id);
    setItemState(card.id, "complete");
    getItem(card.id)!.completedAt = 1; // long past the fade window

    const container = document.createElement("div");
    renderKanban(container, deps({ openLearnings: () => 0 }));

    // Gone entirely — no row for it, so the empty-state message shows.
    expect(groupStateOf(container, "Stale done")).toBeUndefined();
  });
});

describe("kanban — on-hold lane (manual park, furled by default)", () => {
  beforeEach(async () => {
    localStorage.clear();
    const host = new BrowserHost();
    await hydrateCards(host);
    await hydrateSessions(host);
    // Reset the in-memory settings cache to defaults (board view) — list-view
    // tests in this file set kanbanView:"list", and localStorage.clear() alone
    // doesn't clear the cache.
    await hydrateSettings(host);
  });

  it("renders an on-hold column, furled by default (no card bodies)", () => {
    const s = createSession({ title: "Park me", agent: "claude", projectId: "p1" });
    const card = cardFor(s.id);
    setItemState(card.id, "on-hold");

    const container = document.createElement("div");
    renderKanban(container, {
      onStartSession: () => {},
      onOpenSession: () => {},
      onOpenLearnings: () => {},
      openLearnings: () => 0,
    });

    const onHoldCol = columnEl(container, "on-hold");
    expect(onHoldCol.classList.contains("is-furled")).toBe(true);
    // Furled: the count is in the header but no card bodies render.
    expect(onHoldCol.querySelector(".orden-column__count")!.textContent).toBe("1");
    expect(onHoldCol.querySelector(".orden-card")).toBeNull();
    // The furled card is NOT visible anywhere on the board.
    expect(container.querySelector(`.orden-card[data-item-id="${card.id}"]`)).toBeNull();
  });

  it("unfurls on-hold via the header toggle, then refurls (round-trip)", () => {
    const s = createSession({ title: "Park me", agent: "claude", projectId: "p1" });
    const card = cardFor(s.id);
    setItemState(card.id, "on-hold");

    const container = document.createElement("div");
    renderKanban(container, {
      onStartSession: () => {},
      onOpenSession: () => {},
      onOpenLearnings: () => {},
      openLearnings: () => 0,
    });

    const onHoldCol = columnEl(container, "on-hold");
    const toggle = onHoldCol.querySelector<HTMLButtonElement>(".orden-column__furl")!;
    // Unfurl → the held card's body renders.
    toggle.click();
    const reopened = columnEl(container, "on-hold");
    expect(reopened.classList.contains("is-furled")).toBe(false);
    expect(reopened.querySelector(`.orden-card[data-item-id="${card.id}"]`)).not.toBeNull();
    // Refurl → card body hidden again (returns the module state to its default).
    reopened.querySelector<HTMLButtonElement>(".orden-column__furl")!.click();
    expect(columnEl(container, "on-hold").classList.contains("is-furled")).toBe(true);
  });

  it("accepts a drop onto the (furled) on-hold column, parking the card", () => {
    const s = createSession({ title: "Working", agent: "claude", projectId: "p1" });
    const card = cardFor(s.id);
    setItemState(card.id, "in-progress");

    const container = document.createElement("div");
    renderKanban(container, {
      onStartSession: () => {},
      onOpenSession: () => {},
      onOpenLearnings: () => {},
      openLearnings: () => 0,
    });

    // The on-hold column is furled but still accepts drops (drop wiring is on the
    // column, not the card list).
    dropOnto(columnEl(container, "on-hold"), card.id);
    expect(getItem(card.id)?.state).toBe("on-hold");
  });

  it("does not count an on-hold card as needs-action", () => {
    const s = createSession({ title: "Park me", agent: "claude", projectId: "p1" });
    const card = cardFor(s.id);
    setItemState(card.id, "on-hold");

    const container = document.createElement("div");
    const needs = renderKanban(container, {
      onStartSession: () => {},
      onOpenSession: () => {},
      onOpenLearnings: () => {},
      openLearnings: () => 0,
    });

    // on-hold is a manual park, not "awaiting the user" — it never feeds the badge.
    expect(needs).toBe(0);
    expect(container.querySelector(".orden-board__needs-action")).toBeNull();
  });
});
