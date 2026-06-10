import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BrowserHost } from "../src/host/browserHost";
import { hydrateCards, listItems, type Item } from "../src/cards";
import { hydrateSessions, type Agent } from "../src/sessions";
import { openNewCardModal, type NewCardModalDeps } from "../src/newCardModal";

function buttonByText(root: ParentNode, text: string): HTMLButtonElement | undefined {
  return [...root.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent?.trim() === text,
  );
}

const overlay = (): HTMLElement | null => document.querySelector(".card-modal-overlay");

function open(deps: Partial<NewCardModalDeps> = {}): void {
  openNewCardModal(
    { projectId: "p1", title: "Fix the test", description: "It fails twice a day." },
    {
      onStartSession: deps.onStartSession ?? (() => {}),
      onChange: deps.onChange ?? (() => {}),
      onDismiss: deps.onDismiss,
      anchor: deps.anchor,
    },
  );
}

// An element that measures like a real add bar (happy-dom rects are all zero).
function measurableAnchor(): HTMLElement {
  const el = document.createElement("div");
  el.getBoundingClientRect = () =>
    ({ left: 100, top: 200, width: 600, height: 33 }) as DOMRect;
  return el;
}

describe("new-card modal", () => {
  beforeEach(async () => {
    localStorage.clear();
    const host = new BrowserHost();
    await hydrateCards(host);
    await hydrateSessions(host);
  });

  afterEach(() => {
    document.querySelectorAll(".card-modal-overlay").forEach((n) => n.remove());
  });

  it("opens pre-filled, with focus at the end of the description", () => {
    open();
    const title = overlay()!.querySelector<HTMLInputElement>(".card-modal__title")!;
    const desc = overlay()!.querySelector<HTMLTextAreaElement>(".card-modal__desc")!;
    expect(title.value).toBe("Fix the test");
    expect(desc.value).toBe("It fails twice a day.");
    expect(document.activeElement).toBe(desc);
    expect(desc.selectionStart).toBe(desc.value.length);
  });

  it("Add creates the card with title + description and closes", () => {
    let changed = 0;
    open({ onChange: () => changed++ });
    buttonByText(overlay()!, "Add")!.click();
    const item = listItems()[0];
    expect(item.title).toBe("Fix the test");
    expect(item.description).toBe("It fails twice a day.");
    expect(item.projectId).toBe("p1");
    expect(item.state).toBe("planning");
    expect(overlay()).toBeNull();
    expect(changed).toBe(1);
  });

  it("edits made in the modal are what get saved", () => {
    open();
    const title = overlay()!.querySelector<HTMLInputElement>(".card-modal__title")!;
    const desc = overlay()!.querySelector<HTMLTextAreaElement>(".card-modal__desc")!;
    title.value = "Better title";
    desc.value = "Better description";
    buttonByText(overlay()!, "Add")!.click();
    const item = listItems()[0];
    expect(item.title).toBe("Better title");
    expect(item.description).toBe("Better description");
  });

  it("Escape dismisses without creating, restoring the joined text", () => {
    const restored: string[] = [];
    open({ onDismiss: (t) => restored.push(t) });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(overlay()).toBeNull();
    expect(listItems()).toEqual([]);
    expect(restored).toEqual(["Fix the test. It fails twice a day."]);
  });

  it("Cancel closes without creating and without restoring", () => {
    const restored: string[] = [];
    open({ onDismiss: (t) => restored.push(t) });
    buttonByText(overlay()!, "Cancel")!.click();
    expect(overlay()).toBeNull();
    expect(listItems()).toEqual([]);
    expect(restored).toEqual([]);
  });

  it("an agent mark adds the card and starts a session on it", () => {
    const started: Array<{ item: Item; agent: Agent }> = [];
    open({ onStartSession: (item, agent) => started.push({ item, agent }) });
    overlay()!.querySelector<HTMLButtonElement>(".agent-launch__btn")!.click();
    expect(overlay()).toBeNull();
    expect(started).toHaveLength(1);
    expect(started[0].item.description).toBe("It fails twice a day.");
    expect(listItems()[0].id).toBe(started[0].item.id);
  });

  it("grows in-situ from a measurable anchor: description box over it, not centered", () => {
    open({ anchor: measurableAnchor() });
    const o = overlay()!;
    const modal = o.querySelector<HTMLElement>(".card-modal")!;
    expect(o.classList.contains("card-modal-overlay--insitu")).toBe(true);
    expect(modal.classList.contains("card-modal--insitu")).toBe(true);
    // The DESCRIPTION box lands exactly on the anchor: modal position is the
    // anchor's minus the description's offsets inside the modal, and modal
    // width is the anchor's plus the chrome around the description. happy-dom
    // measures offsets/widths as 0, so the modal rect equals the anchor rect.
    expect(modal.style.left).toBe("100px");
    expect(modal.style.top).toBe("200px");
    expect(modal.style.width).toBe("600px");
  });

  it("stays a centered modal without an anchor", () => {
    open();
    expect(overlay()!.classList.contains("card-modal-overlay--insitu")).toBe(false);
  });

  it("falls back to centered when the anchor measures empty (headless)", () => {
    open({ anchor: document.createElement("div") });
    expect(overlay()!.classList.contains("card-modal-overlay--insitu")).toBe(false);
  });

  it("a cleared description saves none", () => {
    open();
    overlay()!.querySelector<HTMLTextAreaElement>(".card-modal__desc")!.value = "  ";
    buttonByText(overlay()!, "Add")!.click();
    expect(listItems()[0].description).toBeUndefined();
  });
});
