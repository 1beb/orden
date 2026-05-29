import { beforeEach, describe, expect, it } from "vitest";
import { BrowserHost } from "../src/host/browserHost";
import { hydrateCards, listItems } from "../src/cards";
import {
  addMessage,
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
    await hydrateCards(h);
    await hydrateSessions(h);
  });

  it("lists nothing before any session", () => {
    expect(listSessions()).toEqual([]);
  });

  it("createSession returns a claude/opencode session with an empty transcript", () => {
    const s = createSession({ title: "Fix the bug", agent: "claude" });
    expect(s.title).toBe("Fix the bug");
    expect(s.agent).toBe("claude");
    expect(s.messages).toEqual([]);
    expect(getSession(s.id)?.title).toBe("Fix the bug");
  });

  it("creating a session adds a linked kanban card in backlog (separate but linked)", () => {
    const s = createSession({ title: "Triage", agent: "opencode" });
    const card = listItems().find((i) => i.sessionId === s.id);
    expect(card).toBeTruthy();
    expect(card!.state).toBe("backlog");
    expect(card!.title).toBe("Triage");
  });

  it("addMessage appends to the transcript", () => {
    const s = createSession({ title: "Chat", agent: "claude" });
    addMessage(s.id, "user", "hello");
    addMessage(s.id, "agent", "hi there");
    expect(getSession(s.id)!.messages.map((m) => [m.role, m.text])).toEqual([
      ["user", "hello"],
      ["agent", "hi there"],
    ]);
  });

  it("persists across a re-hydrate", async () => {
    const s = createSession({ title: "Durable", agent: "claude" });
    addMessage(s.id, "user", "kept");
    await settle();
    await hydrateSessions(new BrowserHost());
    expect(getSession(s.id)?.messages[0]?.text).toBe("kept");
  });
});
