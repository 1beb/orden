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
  cardDocuments,
  type Item,
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

  it("a web persist UNIONS sessionIds — never drops a link the host added while the cache lagged", async () => {
    // Repro for the "claude mark starts a NEW session instead of resuming" bug:
    // the host links a session straight to the vault (session_create / an MCP
    // tool) before the web change-feed roundtrip updates our cache. A web card
    // edit in that window writes the whole (link-less) cached record. Without the
    // union it clobbers the host's link to empty, and the card then shows the
    // start-new launcher where Resume should be. The persist must merge, not drop.
    const h = new BrowserHost();
    await hydrateCards(h);
    const i = addItem("p1", "x", { sessionId: "sess_web" });
    await settle();
    const rec = (await h.vault.get<{ sessionIds: string[] }>("cards", i.id))!;
    await h.vault.set("cards", i.id, { ...rec, sessionIds: [...rec.sessionIds, "sess_host"] });
    // A web edit persists the cached record, which never saw sess_host.
    setItemState(i.id, "in-progress");
    await settle();
    const after = await h.vault.get<{ sessionIds: string[]; state: string }>("cards", i.id);
    expect(after?.sessionIds.slice().sort()).toEqual(["sess_host", "sess_web"]);
    expect(after?.state).toBe("in-progress"); // the web's own change still landed
  });

  it("removeItemSession drops exactly one link on disk and the union persist can't resurrect it", async () => {
    const h = new BrowserHost();
    await hydrateCards(h);
    const i = addItem("p1", "x", { sessionId: "sess_a" });
    addItemSession(i.id, "sess_b");
    await settle();
    removeItemSession(i.id, "sess_a");
    await settle();
    const after = await h.vault.get<{ sessionIds: string[] }>("cards", i.id);
    expect(after?.sessionIds).toEqual(["sess_b"]);
  });

  it("a web persist preserves host-stamped integration fields (publishState/prUrl)", async () => {
    const h = new BrowserHost();
    await hydrateCards(h);
    const i = addItem("p1", "x");
    await settle();
    const rec = (await h.vault.get<Record<string, unknown>>("cards", i.id))!;
    await h.vault.set("cards", i.id, { ...rec, publishState: "pr-opened", prUrl: "https://x/pr/1" });
    setItemState(i.id, "complete"); // a web edit that rewrites the whole record
    await settle();
    const after = await h.vault.get<Record<string, unknown>>("cards", i.id);
    expect(after?.publishState).toBe("pr-opened");
    expect(after?.prUrl).toBe("https://x/pr/1");
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

  it("cardDocuments lists the planDoc plus docs the card's sessions surfaced", async () => {
    const h = new BrowserHost();
    await hydrateCards(h);
    // A session of this card opened two docs; an unrelated session opened a third.
    await h.vault.set("doclinks", "out/review.html", { sessionId: "sess_a" });
    await h.vault.set("doclinks", "/abs/report.md", { sessionId: "sess_b" });
    await h.vault.set("doclinks", "out/other.html", { sessionId: "sess_other" });

    const item: Item = {
      id: "c1",
      projectId: "p1",
      title: "card",
      state: "planning",
      notes: "",
      sessionIds: ["sess_a", "sess_b"],
      planDoc: "docs/plans/2026-06-23-x.md",
    };
    const docs = await cardDocuments(item);

    // planDoc first (under the card's project), then the linked sessions' docs.
    expect(docs).toContainEqual({
      path: "docs/plans/2026-06-23-x.md",
      projectId: "p1",
      source: "plan",
    });
    // A relative doc opens under its surfacing session's worktree root.
    expect(docs).toContainEqual({
      path: "out/review.html",
      projectId: "session:sess_a",
      source: "session",
    });
    // An absolute doc opens through the host root.
    expect(docs).toContainEqual({
      path: "/abs/report.md",
      projectId: "host",
      source: "session",
    });
    // A doc surfaced by a session NOT linked to this card is excluded.
    expect(docs.map((d) => d.path)).not.toContain("out/other.html");
  });

  it("cardDocuments returns nothing for a card with no planDoc and no sessions", async () => {
    const h = new BrowserHost();
    await hydrateCards(h);
    await h.vault.set("doclinks", "out/x.html", { sessionId: "sess_z" });
    const item: Item = {
      id: "c2",
      projectId: "p1",
      title: "bare",
      state: "planning",
      notes: "",
      sessionIds: [],
    };
    expect(await cardDocuments(item)).toEqual([]);
  });

  it("cardDocuments de-dupes a path that is both the planDoc and a session link, keeping plan", async () => {
    const h = new BrowserHost();
    await hydrateCards(h);
    await h.vault.set("doclinks", "docs/plans/2026-06-23-x.md", { sessionId: "sess_a" });
    const item: Item = {
      id: "c3",
      projectId: "p1",
      title: "card",
      state: "planning",
      notes: "",
      sessionIds: ["sess_a"],
      planDoc: "docs/plans/2026-06-23-x.md",
    };
    const docs = await cardDocuments(item);
    expect(docs).toHaveLength(1);
    expect(docs[0]).toEqual({
      path: "docs/plans/2026-06-23-x.md",
      projectId: "p1",
      source: "plan",
    });
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
