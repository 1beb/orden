import { beforeEach, describe, expect, it } from "vitest";
import { BrowserHost } from "../src/host/browserHost";
import { hydrateCards, listItems, cardSessionIds } from "../src/cards";
import { hydrateProjects, getProject } from "../src/projects";
import {
  createSession,
  getSession,
  hydrateSessions,
  listSessions,
  deleteSession,
  ensureSummary,
  setSessionSummary,
  type Session,
} from "../src/sessions";

const settle = () => new Promise((r) => setTimeout(r, 10));

describe("sessions store (host-backed)", () => {
  beforeEach(async () => {
    localStorage.clear();
    const h = new BrowserHost();
    await hydrateProjects(h);
    await hydrateCards(h);
    await hydrateSessions(h);
  });

  it("a session with no project lands in the default Homeroom project", () => {
    const s = createSession({ title: "Loose thought", agent: "claude" });
    expect(s.projectId).toBe("homeroom");
    expect(getProject("homeroom")?.name).toBe("Homeroom");
  });

  it("lists nothing before any session", () => {
    expect(listSessions()).toEqual([]);
  });

  it("createSession returns a claude/opencode session", () => {
    const s = createSession({ title: "Fix the bug", agent: "claude" });
    expect(s.title).toBe("Fix the bug");
    expect(s.agent).toBe("claude");
    expect(getSession(s.id)?.title).toBe("Fix the bug");
  });

  it("creating a session adds a linked kanban card in planning (separate but linked)", () => {
    const s = createSession({ title: "Triage", agent: "opencode" });
    const card = listItems().find((i) => cardSessionIds(i).includes(s.id));
    expect(card).toBeTruthy();
    expect(card!.state).toBe("planning");
    expect(card!.title).toBe("Triage");
  });

  it("persists across a re-hydrate", async () => {
    const s = createSession({ title: "Durable", agent: "claude" });
    await settle();
    await hydrateSessions(new BrowserHost());
    expect(getSession(s.id)?.title).toBe("Durable");
  });

  it("deleteSession removes the session but KEEPS its (now session-less) card", () => {
    const s = createSession({ title: "Detach me", agent: "claude" });
    const card = listItems().find((i) => cardSessionIds(i).includes(s.id))!;
    deleteSession(s.id);
    expect(getSession(s.id)).toBeUndefined();
    const stillThere = listItems().find((i) => i.id === card.id);
    expect(stillThere).toBeTruthy();
    expect(cardSessionIds(stillThere!)).toEqual([]);
  });

  it("ensureSummary seeds from the title once a card is complete; no-op otherwise", () => {
    const s = createSession({ title: "Wrap up", agent: "claude" });
    ensureSummary(s, "in-progress");
    expect(s.summary).toBeUndefined(); // not done yet
    ensureSummary(s, "complete");
    expect(s.summary).toBe("Wrap up");
  });

  it("ensureSummary never clobbers an existing summary", () => {
    const s = createSession({ title: "Has one", agent: "claude" });
    setSessionSummary(s.id, "hand-written digest");
    ensureSummary(getSession(s.id) as Session, "complete");
    expect(getSession(s.id)?.summary).toBe("hand-written digest");
  });
});
