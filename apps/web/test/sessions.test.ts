import { beforeEach, describe, expect, it } from "vitest";
import { BrowserHost } from "../src/host/browserHost";
import { hydrateCards, listItems } from "../src/cards";
import { hydrateProjects, getProject } from "../src/projects";
import {
  createSession,
  getSession,
  hydrateSessions,
  listSessions,
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
    const card = listItems().find((i) => i.sessionId === s.id);
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
});
