import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BrowserHost } from "../src/host/browserHost";
import { hydrateCards, listItems, getItem, setItemState, cardSessionIds, type Item } from "../src/cards";
import { hydrateSessions, createSession, getSession, onSessionsChange } from "../src/sessions";
import { hydrateProjects, ensureDefaultProject, addProject } from "../src/projects";
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

describe("card modal — title rename propagation", () => {
  beforeEach(async () => {
    localStorage.clear();
    const host = new BrowserHost();
    await hydrateCards(host);
    await hydrateSessions(host);
  });

  afterEach(() => {
    document.querySelectorAll(".card-modal-overlay").forEach((n) => n.remove());
  });

  function renameInModal(cardId: string, onChange: () => void): void {
    openCardModal(cardId, { onStartSession: () => {}, onOpenSession: () => {}, onChange });
    const input = document.querySelector<HTMLInputElement>(".card-modal__title")!;
    input.value = "Renamed title";
    input.dispatchEvent(new Event("change"));
  }

  it("updates the card title (board/list view stays in sync via onChange)", () => {
    const s = createSession({ title: "Old title", agent: "claude", projectId: "p1" });
    const card = cardFor(s.id);
    let changed = 0;
    renameInModal(card.id, () => {
      changed++;
    });
    expect(getItem(card.id)?.title).toBe("Renamed title");
    expect(changed).toBeGreaterThan(0); // board/list re-render fired
  });

  it("renames the card's linked session(s) so the sessions UI matches", () => {
    const s = createSession({ title: "Old title", agent: "claude", projectId: "p1" });
    const card = cardFor(s.id);
    renameInModal(card.id, () => {});
    expect(getSession(s.id)?.title).toBe("Renamed title");
  });

  it("notifies session listeners so the sessions panel re-renders live", () => {
    const s = createSession({ title: "Old title", agent: "claude", projectId: "p1" });
    const card = cardFor(s.id);
    let panelRefreshes = 0;
    const off = onSessionsChange(() => {
      panelRefreshes++;
    });
    renameInModal(card.id, () => {});
    off();
    expect(panelRefreshes).toBeGreaterThan(0);
  });
});

describe("card modal — project reassignment propagation", () => {
  beforeEach(async () => {
    localStorage.clear();
    const host = new BrowserHost();
    await hydrateCards(host);
    await hydrateSessions(host);
    await hydrateProjects(host);
  });

  afterEach(() => {
    document.querySelectorAll(".card-modal-overlay").forEach((n) => n.remove());
  });

  // The Project field is one of several labelled selects; find it by caption.
  function fieldByLabel(label: string): HTMLSelectElement | undefined {
    const labels = [...document.querySelectorAll<HTMLLabelElement>(".card-modal__field")];
    const match = labels.find(
      (l) => l.querySelector(".card-modal__field-label")?.textContent?.trim() === label,
    );
    return match?.querySelector(".card-modal__field-input") as HTMLSelectElement | undefined;
  }

  it("reassigns the card's linked session(s) to the chosen project", () => {
    const home = ensureDefaultProject();
    const other = addProject("Other");
    const s = createSession({ title: "Move me", agent: "claude", projectId: home.id });
    const card = cardFor(s.id);
    openCardModal(card.id, { onStartSession: () => {}, onOpenSession: () => {}, onChange: () => {} });
    const select = fieldByLabel("Project")!;
    select.value = other.id;
    select.dispatchEvent(new Event("change"));
    expect(getSession(s.id)?.projectId).toBe(other.id);
  });

  it("notifies session listeners so the sessions panel re-renders live", () => {
    const home = ensureDefaultProject();
    const other = addProject("Other");
    const s = createSession({ title: "Move me", agent: "claude", projectId: home.id });
    const card = cardFor(s.id);
    let panelRefreshes = 0;
    const off = onSessionsChange(() => {
      panelRefreshes++;
    });
    openCardModal(card.id, { onStartSession: () => {}, onOpenSession: () => {}, onChange: () => {} });
    const select = fieldByLabel("Project")!;
    select.value = other.id;
    select.dispatchEvent(new Event("change"));
    off();
    expect(panelRefreshes).toBeGreaterThan(0);
  });
});

describe("card modal — session removal propagation", () => {
  beforeEach(async () => {
    localStorage.clear();
    const host = new BrowserHost();
    await hydrateCards(host);
    await hydrateSessions(host);
  });

  afterEach(() => {
    document.querySelectorAll(".card-modal-overlay").forEach((n) => n.remove());
  });

  it("removes the session from the cache so the panel stays in sync", () => {
    const s = createSession({ title: "Bye", agent: "claude", projectId: "p1" });
    const card = cardFor(s.id);
    openCardModal(card.id, { onStartSession: () => {}, onOpenSession: () => {}, onChange: () => {} });
    buttonByText(document.body, "Remove")!.click();
    expect(getSession(s.id)).toBeUndefined();
  });

  it("notifies session listeners so the sessions panel re-renders live", () => {
    const s = createSession({ title: "Bye", agent: "claude", projectId: "p1" });
    const card = cardFor(s.id);
    let panelRefreshes = 0;
    const off = onSessionsChange(() => {
      panelRefreshes++;
    });
    openCardModal(card.id, { onStartSession: () => {}, onOpenSession: () => {}, onChange: () => {} });
    buttonByText(document.body, "Remove")!.click();
    off();
    expect(panelRefreshes).toBeGreaterThan(0);
  });
});

describe("card modal — Documents section", () => {
  let host: BrowserHost;
  const tick = () => new Promise((r) => setTimeout(r, 10));

  beforeEach(async () => {
    localStorage.clear();
    host = new BrowserHost();
    await hydrateCards(host);
    await hydrateSessions(host);
  });

  afterEach(() => {
    document.querySelectorAll(".card-modal-overlay").forEach((n) => n.remove());
  });

  function docRows(): HTMLButtonElement[] {
    return [...document.querySelectorAll<HTMLButtonElement>(".card-modal__doc")];
  }

  it("lists the planDoc and the docs the card's sessions surfaced, and opens one on click", async () => {
    const s = createSession({ title: "Has docs", agent: "claude", projectId: "p1" });
    const card = cardFor(s.id);
    Object.assign(card, { planDoc: "docs/plans/2026-06-23-x.md" });
    await host.vault.set("doclinks", "out/review.html", { sessionId: s.id });

    const opened: Array<[string, string]> = [];
    openCardModal(card.id, {
      onStartSession: () => {},
      onOpenSession: () => {},
      onOpenDoc: (path, projectId) => opened.push([path, projectId]),
      onChange: () => {},
    });
    await tick(); // renderDocuments reads doclinks asynchronously

    const rows = docRows();
    expect(rows).toHaveLength(2);
    const names = rows.map((r) => r.querySelector(".card-modal__doc-name")?.textContent);
    expect(names).toContain("2026-06-23-x.md");
    expect(names).toContain("review.html");
    // The planDoc row carries a "plan" badge; the surfaced one does not.
    expect(document.querySelector(".card-modal__doc-badge")?.textContent).toBe("plan");

    // Clicking the surfaced doc opens it under its session's worktree root.
    rows.find((r) => r.title === "out/review.html")!.click();
    expect(opened).toEqual([["out/review.html", `session:${s.id}`]]);
    // And it closes the modal (open handler runs close() first).
    expect(document.querySelector(".card-modal-overlay")).toBeNull();
  });

  it("renders no Documents section for a card with no associated docs", async () => {
    const s = createSession({ title: "No docs", agent: "claude", projectId: "p1" });
    const card = cardFor(s.id);
    openCardModal(card.id, {
      onStartSession: () => {},
      onOpenSession: () => {},
      onOpenDoc: () => {},
      onChange: () => {},
    });
    await tick();
    expect(docRows()).toHaveLength(0);
    expect([...document.querySelectorAll(".card-modal__section-head")].map((e) => e.textContent)).not.toContain(
      "Documents",
    );
  });
});

describe("card modal — integration (branch/PR) row", () => {
  beforeEach(async () => {
    localStorage.clear();
    const host = new BrowserHost();
    await hydrateCards(host);
    await hydrateSessions(host);
  });

  afterEach(() => {
    document.querySelectorAll(".card-modal-overlay").forEach((n) => n.remove());
  });

  function openWith(extra: Partial<Item>): void {
    const s = createSession({ title: "Publishable", agent: "claude", projectId: "p1" });
    const card = cardFor(s.id);
    Object.assign(card, extra);
    openCardModal(card.id, { onStartSession: () => {}, onOpenSession: () => {}, onChange: () => {} });
  }

  it("shows the PR link when a PR was opened", () => {
    openWith({
      publishState: "pr-opened",
      branch: "orden/publishable",
      prUrl: "https://github.com/x/y/pull/3",
    } as Partial<Item>);
    const link = document.querySelector<HTMLAnchorElement>(".card-modal__integration a");
    expect(link?.href).toBe("https://github.com/x/y/pull/3");
    expect(document.body.textContent).toContain("orden/publishable");
  });

  it("shows pushed + compare link without a PR", () => {
    openWith({
      publishState: "pushed",
      branch: "orden/publishable",
      compareUrl: "https://github.com/x/y/compare/orden%2Fpublishable?expand=1",
    } as Partial<Item>);
    const link = document.querySelector<HTMLAnchorElement>(".card-modal__integration a");
    expect(link?.href).toContain("/compare/");
  });

  it("warns on a dirty (unpublished) completion", () => {
    openWith({ publishState: "dirty", branch: "orden/publishable" } as Partial<Item>);
    expect(document.querySelector(".card-modal__integration")?.textContent).toContain(
      "not published",
    );
  });

  it("renders no integration row without publish state", () => {
    openWith({});
    expect(document.querySelector(".card-modal__integration")).toBeNull();
  });
});
