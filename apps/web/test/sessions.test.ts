import { beforeEach, describe, expect, it } from "vitest";
import { BrowserHost } from "../src/host/browserHost";
import { hydrateCards, listItems, cardSessionIds, setItemState } from "../src/cards";
import { hydrateProjects, getProject } from "../src/projects";
import { hydrateSettings, type Settings } from "../src/settings";
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
  completeSessionViaAgent,
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
    // Reset the module-global settings cache to defaults (claude/opencode = tui)
    // so a prior test's gui hydrate doesn't leak into the default-mode cases.
    await hydrateSettings(h);
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

  it("flags the persisted record pendingLaunch so the host spawns the agent on create", async () => {
    // Web session starts are explicit user actions, so the agent must launch
    // immediately — not lazily when the Terminal tab attaches. Otherwise a panel
    // that opens on the Chat tab (which only mirrors) never spawns the agent.
    const h = new BrowserHost();
    await hydrateProjects(h);
    await hydrateCards(h);
    await hydrateSessions(h);
    const s = createSession({ title: "Launch me", agent: "claude" });
    await settle();
    const rec = await h.vault.get<{ pendingLaunch?: boolean }>("sessions", s.id);
    expect(rec?.pendingLaunch).toBe(true);
    // The in-memory cache stays clean so later persists don't re-trigger launch.
    expect((getSession(s.id) as Session & { pendingLaunch?: boolean }).pendingLaunch).toBeUndefined();
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

  // The checkmark must route completion through the session's agent (so it can
  // distill learnings before card_complete) whenever an agent can be reached —
  // and fall back to the direct archive+complete write when it can't.
  describe("completeSessionViaAgent", () => {
    async function hostWith(delivered: "queued" | "relaunched" | "failed" | "not-linked") {
      const h = new BrowserHost();
      const calls: string[] = [];
      h.requestSessionComplete = async (id: string) => {
        calls.push(id);
        return { delivered };
      };
      await hydrateProjects(h);
      await hydrateCards(h);
      await hydrateSessions(h);
      return { h, calls };
    }

    it("hands completion to the agent and leaves the card/record untouched", async () => {
      const { calls } = await hostWith("queued");
      const s = createSession({ title: "Real work", agent: "claude" });
      markSessionTouched(s.id); // a session someone actually worked in
      await expect(completeSessionViaAgent(s.id)).resolves.toBe(true);
      expect(calls).toEqual([s.id]);
      // The agent now owns completion: nothing flipped, nothing hidden.
      const card = listItems().find((i) => cardSessionIds(i).includes(s.id))!;
      expect(card.state).toBe("planning");
      expect(getSession(s.id)?.archived).toBeUndefined();
    });

    it("counts a relaunch as handed off (dead session resumes with the request queued)", async () => {
      await hostWith("relaunched");
      const s = createSession({ title: "Resumable", agent: "claude" });
      markSessionTouched(s.id);
      await expect(completeSessionViaAgent(s.id)).resolves.toBe(true);
    });

    it("reports failure so the caller falls back to the direct complete", async () => {
      await hostWith("failed");
      const s = createSession({ title: "Unreachable", agent: "claude" });
      markSessionTouched(s.id);
      await expect(completeSessionViaAgent(s.id)).resolves.toBe(false);
    });

    it("falls back when the host has no agent delivery (browser host)", async () => {
      const s = createSession({ title: "Browser only", agent: "claude" });
      markSessionTouched(s.id);
      await expect(completeSessionViaAgent(s.id)).resolves.toBe(false);
    });

    it("falls back when the linked card is already complete (checkmark = plain archive)", async () => {
      const { calls } = await hostWith("queued");
      const s = createSession({ title: "Already done", agent: "claude" });
      markSessionTouched(s.id);
      const card = listItems().find((i) => cardSessionIds(i).includes(s.id))!;
      setItemState(card.id, "complete");
      await expect(completeSessionViaAgent(s.id)).resolves.toBe(false);
      expect(calls).toEqual([]);
    });

    it("falls back for a dead stub (never touched, never prompted, no conversation)", async () => {
      const { calls } = await hostWith("queued");
      const s = createSession({ title: "Stub", agent: "claude" });
      await expect(completeSessionViaAgent(s.id)).resolves.toBe(false);
      expect(calls).toEqual([]);
    });

    it("never throws — a delivery error degrades to the fallback", async () => {
      const { h } = await hostWith("queued");
      h.requestSessionComplete = async () => {
        throw new Error("rpc down");
      };
      const s = createSession({ title: "Flaky", agent: "claude" });
      markSessionTouched(s.id);
      await expect(completeSessionViaAgent(s.id)).resolves.toBe(false);
    });
  });

  it("a web persist never clobbers the host-minted conversationId (cache-lag race)", async () => {
    // The host mints conversationId in buildCommand at launch and writes it
    // straight to the vault; the web cache only catches up on an async
    // change-feed roundtrip, so right after launch the cache still has no id.
    // A web-side persist in that window (the first-keystroke markSessionTouched)
    // must NOT write its stale cached record back over the host's id — doing so
    // severs the hook->card mapping (sessionForConversation matches on
    // conversationId) and freezes the card at planning. Regression guard.
    const h = new BrowserHost();
    await hydrateProjects(h);
    await hydrateCards(h);
    await hydrateSessions(h);
    const s = createSession({ title: "Launch me", agent: "claude" });
    await settle();
    // Host writes conversationId directly to the vault, bypassing the cache.
    const rec = (await h.vault.get<Session>("sessions", s.id)) as Session;
    await h.vault.set("sessions", s.id, { ...rec, conversationId: "host-minted-id" });
    // Web persist fires while the cache is still id-less.
    markSessionTouched(s.id);
    await settle();
    const after = await h.vault.get<Session>("sessions", s.id);
    expect(after?.conversationId).toBe("host-minted-id"); // survived
    expect(after?.touched).toBe(true); // the web's own change still landed
  });

  it("a web persist never clobbers the host-authored `prompted` flag", async () => {
    // Same mechanism as conversationId: `prompted` flows host -> vault -> cache
    // only (reapDeadSessions reads it to spare real work). A stale-cache persist
    // must preserve it.
    const h = new BrowserHost();
    await hydrateProjects(h);
    await hydrateCards(h);
    await hydrateSessions(h);
    const s = createSession({ title: "Untitled", agent: "claude" });
    await settle();
    const rec = (await h.vault.get<Session>("sessions", s.id)) as Session;
    await h.vault.set("sessions", s.id, { ...rec, prompted: true });
    markSessionTouched(s.id);
    await settle();
    const after = await h.vault.get<Session & { prompted?: boolean }>("sessions", s.id);
    expect(after?.prompted).toBe(true);
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

  it("stamps a GUI claude session's mode and OMITS pendingLaunch (Chat mount launches it)", async () => {
    const h = new BrowserHost();
    await h.vault.set("settings", "app", {
      defaultMode: { claude: "gui", opencode: "tui" },
    } as Partial<Settings>);
    await hydrateProjects(h);
    await hydrateCards(h);
    await hydrateSessions(h);
    await hydrateSettings(h);

    const s = createSession({ title: "GUI claude", agent: "claude" });
    expect(s.mode).toBe("gui");
    await settle();
    const rec = await h.vault.get<Session & { pendingLaunch?: boolean }>("sessions", s.id);
    expect(rec?.mode).toBe("gui");
    expect(rec?.pendingLaunch).toBeUndefined();
  });

  it("stamps a TUI claude session's mode and KEEPS pendingLaunch", async () => {
    const h = new BrowserHost();
    await h.vault.set("settings", "app", {
      defaultMode: { claude: "tui", opencode: "gui" },
    } as Partial<Settings>);
    await hydrateProjects(h);
    await hydrateCards(h);
    await hydrateSessions(h);
    await hydrateSettings(h);

    const s = createSession({ title: "TUI claude", agent: "claude" });
    expect(s.mode).toBe("tui");
    await settle();
    const rec = await h.vault.get<Session & { pendingLaunch?: boolean }>("sessions", s.id);
    expect(rec?.mode).toBe("tui");
    expect(rec?.pendingLaunch).toBe(true);
  });

  it("opencode respects its own defaultMode independently of claude", async () => {
    const h = new BrowserHost();
    await h.vault.set("settings", "app", {
      defaultMode: { claude: "tui", opencode: "gui" },
    } as Partial<Settings>);
    await hydrateProjects(h);
    await hydrateCards(h);
    await hydrateSessions(h);
    await hydrateSettings(h);

    const s = createSession({ title: "GUI opencode", agent: "opencode" });
    expect(s.mode).toBe("gui");
    await settle();
    const rec = await h.vault.get<Session & { pendingLaunch?: boolean }>("sessions", s.id);
    expect(rec?.pendingLaunch).toBeUndefined();
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
