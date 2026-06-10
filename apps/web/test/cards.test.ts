import { beforeEach, describe, expect, it } from "vitest";
import { BrowserHost } from "../src/host/browserHost";
import {
  addItem,
  hydrateCards,
  itemsByProject,
  listItems,
  setItemState,
  setItemDueDate,
  setItemDescription,
  promptForItem,
  addItemSession,
  removeItemSession,
  cardSessionIds,
} from "../src/cards";

const settle = () => new Promise((r) => setTimeout(r, 10));

describe("cards store (host-backed)", () => {
  beforeEach(async () => {
    localStorage.clear();
    await hydrateCards(new BrowserHost());
  });

  it("lists nothing before any item is added", () => {
    expect(listItems()).toEqual([]);
  });

  it("addItem returns a planning item with id, project and trimmed title", () => {
    const i = addItem("proj1", "  Do the thing  ");
    expect(i.projectId).toBe("proj1");
    expect(i.title).toBe("Do the thing");
    expect(i.state).toBe("planning");
    expect(typeof i.id).toBe("string");
  });

  it("itemsByProject filters by project", () => {
    addItem("p1", "a");
    addItem("p2", "b");
    expect(itemsByProject("p1").map((i) => i.title)).toEqual(["a"]);
  });

  it("setItemState changes an item's state", () => {
    const i = addItem("p1", "x");
    setItemState(i.id, "in-progress");
    expect(listItems().find((x) => x.id === i.id)?.state).toBe("in-progress");
  });

  it("persists across a re-hydrate (fresh host over the same vault)", async () => {
    const i = addItem("p1", "kept");
    setItemState(i.id, "blocked");
    await settle();
    await hydrateCards(new BrowserHost());
    const got = listItems().find((x) => x.id === i.id);
    expect(got?.title).toBe("kept");
    expect(got?.state).toBe("blocked");
  });

  it("addItem starts with an empty sessionIds array (or seeds one)", () => {
    expect(addItem("p1", "no sessions").sessionIds).toEqual([]);
    expect(addItem("p1", "seeded", { sessionId: "sess_1" }).sessionIds).toEqual(["sess_1"]);
  });

  it("addItemSession / removeItemSession link and unlink sessions (deduped)", () => {
    const i = addItem("p1", "x");
    addItemSession(i.id, "sess_a");
    addItemSession(i.id, "sess_a"); // dedupe
    addItemSession(i.id, "sess_b");
    expect(cardSessionIds(listItems().find((x) => x.id === i.id)!)).toEqual(["sess_a", "sess_b"]);
    removeItemSession(i.id, "sess_a");
    expect(cardSessionIds(listItems().find((x) => x.id === i.id)!)).toEqual(["sess_b"]);
  });

  it("stamps completedAt entering complete, preserves it on re-set, clears it on leaving", () => {
    const i = addItem("p1", "x");
    expect(listItems().find((x) => x.id === i.id)?.completedAt).toBeUndefined();

    setItemState(i.id, "complete");
    const stamped = listItems().find((x) => x.id === i.id)?.completedAt;
    expect(typeof stamped).toBe("number");

    // Re-setting to complete keeps the original stamp (fade clock unchanged).
    setItemState(i.id, "complete");
    expect(listItems().find((x) => x.id === i.id)?.completedAt).toBe(stamped);

    // Leaving complete clears the stamp.
    setItemState(i.id, "in-progress");
    expect(listItems().find((x) => x.id === i.id)?.completedAt).toBeUndefined();
  });

  it("addItem stores a description; setItemDescription edits and clears it", () => {
    const i = addItem("p1", "x", { description: "  more context  " });
    expect(listItems().find((x) => x.id === i.id)?.description).toBe("more context");
    setItemDescription(i.id, "rewritten");
    expect(listItems().find((x) => x.id === i.id)?.description).toBe("rewritten");
    setItemDescription(i.id, "   ");
    expect(listItems().find((x) => x.id === i.id)?.description).toBeUndefined();
  });

  it("promptForItem joins title and description; title alone without one", () => {
    const bare = addItem("p1", "Just a title");
    expect(promptForItem(bare)).toBe("Just a title");
    const full = addItem("p1", "Fix the test", { description: "It fails twice a day." });
    expect(promptForItem(full)).toBe("Fix the test\n\nIt fails twice a day.");
  });

  it("setItemDueDate sets and clears a due date", () => {
    const i = addItem("p1", "x");
    setItemDueDate(i.id, "2026-06-01");
    expect(listItems().find((x) => x.id === i.id)?.dueDate).toBe("2026-06-01");
    setItemDueDate(i.id, undefined);
    expect(listItems().find((x) => x.id === i.id)?.dueDate).toBeUndefined();
  });

  it("migrates a legacy single sessionId into sessionIds on hydrate", async () => {
    const host = new BrowserHost();
    await host.vault.set("cards", "L_sess", {
      id: "L_sess",
      projectId: "p1",
      title: "legacy",
      state: "planning",
      notes: "",
      sessionId: "sess_legacy",
    });
    await hydrateCards(host);
    const got = listItems().find((x) => x.id === "L_sess")!;
    expect(got.sessionIds).toEqual(["sess_legacy"]);
    expect(got.sessionId).toBeUndefined();
  });

  it("migrates legacy states to the four-state set on hydrate", async () => {
    // Seed the vault directly with cards carrying legacy states.
    const host = new BrowserHost();
    const legacy = [
      { id: "L_backlog", state: "backlog", want: "planning" },
      { id: "L_todo", state: "todo", want: "planning" },
      { id: "L_ready", state: "ready", want: "complete" },
      { id: "L_broken", state: "broken", want: "blocked" },
      { id: "L_inprog", state: "in-progress", want: "in-progress" },
      { id: "L_unknown", state: "weird", want: "planning" },
    ];
    for (const { id, state } of legacy) {
      await host.vault.set("cards", id, {
        id,
        projectId: "p1",
        title: id,
        state,
        notes: "",
      });
    }
    await hydrateCards(host);
    for (const { id, want } of legacy) {
      expect(listItems().find((x) => x.id === id)?.state).toBe(want);
    }
  });
});
