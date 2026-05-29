import { beforeEach, describe, expect, it } from "vitest";
import { BrowserHost } from "../src/host/browserHost";
import {
  addItem,
  hydrateCards,
  itemsByProject,
  listItems,
  setItemState,
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

  it("addItem returns a backlog item with id, project and trimmed title", () => {
    const i = addItem("proj1", "  Do the thing  ");
    expect(i.projectId).toBe("proj1");
    expect(i.title).toBe("Do the thing");
    expect(i.state).toBe("backlog");
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
    setItemState(i.id, "ready");
    await settle();
    await hydrateCards(new BrowserHost());
    const got = listItems().find((x) => x.id === i.id);
    expect(got?.title).toBe("kept");
    expect(got?.state).toBe("ready");
  });
});
