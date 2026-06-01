import { beforeEach, describe, expect, it } from "vitest";
import { BrowserHost } from "../src/host/browserHost";
import { hydrateCards, listItems, cardSessionIds, setItemState } from "../src/cards";
import { hydrateProjects, getProject } from "../src/projects";
import {
  createSession,
  getSession,
  hydrateSessions,
  listSessions,
  deleteSession,
  reapDeadSessions,
  ensureSummary,
  setSessionSummary,
  isAbandoned,
  markSessionTouched,
  isSessionComplete,
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

  it("deleteSession also asks the host to kill the session's agent", async () => {
    const killed: string[] = [];
    const h = new BrowserHost();
    h.sessions.kill = async (id: string) => {
      killed.push(id);
    };
    await hydrateProjects(h);
    await hydrateCards(h);
    await hydrateSessions(h);
    const s = createSession({ title: "Reap me", agent: "claude" });
    deleteSession(s.id);
    expect(killed).toContain(s.id);
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

  it("markSessionTouched flips isAbandoned synchronously (the navigate-away reap path)", () => {
    // Reproduces the bug: create an Untitled session, type a prompt, navigate
    // away fast. cleanup() reaps via isAbandoned, which reads the cache — so the
    // touch must land in the cache immediately, not after a host roundtrip.
    const s = createSession({ title: "Untitled", agent: "claude" });
    expect(isAbandoned(s)).toBe(true);
    markSessionTouched(s.id);
    expect(isAbandoned(getSession(s.id) as Session)).toBe(false);
  });

  it("markSessionTouched writes through and survives a re-hydrate", async () => {
    const s = createSession({ title: "Untitled", agent: "claude" });
    markSessionTouched(s.id);
    await settle();
    await hydrateSessions(new BrowserHost());
    expect(getSession(s.id)?.touched).toBe(true);
  });

  it("isSessionComplete is true once the linked card reaches Complete", () => {
    const s = createSession({ title: "Ship it", agent: "claude" });
    const card = listItems().find((i) => cardSessionIds(i).includes(s.id))!;
    expect(isSessionComplete(s)).toBe(false);
    setItemState(card.id, "complete");
    expect(isSessionComplete(s)).toBe(true);
  });

  it("reapDeadSessions spares an Untitled session the host flagged `prompted`", () => {
    const ghost = createSession({ title: "Untitled", agent: "claude" });
    const prompted = createSession({ title: "Untitled", agent: "claude" });
    // The host reconcile sets `prompted` after finding a real human turn in the
    // transcript; it reaches us via the vault → cache. Mirror that here.
    (getSession(prompted.id) as Session).prompted = true;

    const reaped = reapDeadSessions();
    expect(reaped).toContain(ghost.id);
    expect(reaped).not.toContain(prompted.id);
    expect(getSession(prompted.id)?.id).toBe(prompted.id);
  });

  it("reapDeadSessions drops Untitled stubs but keeps titled work", () => {
    const ghost = createSession({ title: "Untitled", agent: "claude" });
    const blank = createSession({ title: "", agent: "opencode" }); // -> "Untitled session"
    const real = createSession({ title: "Real task", agent: "claude" });

    const reaped = reapDeadSessions();
    expect(reaped.sort()).toEqual([blank.id, ghost.id].sort());
    expect(getSession(ghost.id)).toBeUndefined();
    expect(getSession(blank.id)).toBeUndefined();
    expect(getSession(real.id)?.title).toBe("Real task");
    expect(listSessions().map((s) => s.id)).toEqual([real.id]);
  });
});
