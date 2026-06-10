import { describe, it, expect, beforeEach } from "vitest";
import { mountSessionsPanel } from "../src/sessionsPanel";
import type { Agent, Session } from "../src/sessions";
import { saveSettings } from "../src/settings";

function makeSession(over: Partial<Session> = {}): Session {
  return {
    id: "s1",
    title: "Untitled",
    agent: "claude",
    projectId: "p1",
    ...over,
  };
}

function deps(over: Partial<Parameters<typeof mountSessionsPanel>[0]> = {}) {
  const created: { title: string; agent: Agent }[] = [];
  const base = {
    container: document.createElement("div"),
    list: () => [] as Session[],
    get: () => undefined,
    create: (opts: { title: string; agent: Agent }) => {
      created.push(opts);
      return makeSession({ id: `s${created.length}`, agent: opts.agent });
    },
    projectName: () => "Homeroom",
    mountTerminal: () => () => {},
    archive: () => {},
    remove: () => {},
    cleanup: () => {},
  };
  return { created, deps: { ...base, ...over } };
}

// Find a new-session agent button by its accessible label (no text — they show
// brand-mark SVGs). The two buttons live in the header, one per agent.
function agentButton(container: HTMLElement, name: string): HTMLButtonElement {
  const btn = [...container.querySelectorAll<HTMLButtonElement>(".sess-agent-btn")].find(
    (b) => b.getAttribute("aria-label") === `New ${name} session`,
  );
  if (!btn) throw new Error(`no new-session button for ${name}`);
  return btn;
}

describe("sessionsPanel new-session agent buttons", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it("offers a direct Claude and opencode icon button (no dropdown menu)", () => {
    const { deps: d } = deps();
    document.body.append(d.container);
    mountSessionsPanel(d);

    expect(d.container.querySelector(".sess-menu")).toBeNull();
    const labels = [...d.container.querySelectorAll<HTMLButtonElement>(".sess-agent-btn")].map((b) =>
      b.getAttribute("aria-label"),
    );
    expect(labels).toEqual(["New Claude session", "New opencode session"]);
  });

  it("clicking the opencode icon creates a session with agent=opencode", () => {
    const { created, deps: d } = deps();
    document.body.append(d.container);
    mountSessionsPanel(d);

    agentButton(d.container, "opencode").click();

    expect(created).toEqual([{ title: "Untitled", agent: "opencode" }]);
  });

  it("clicking the Claude icon creates a session with agent=claude", () => {
    const { created, deps: d } = deps();
    document.body.append(d.container);
    mountSessionsPanel(d);

    agentButton(d.container, "Claude").click();

    expect(created).toEqual([{ title: "Untitled", agent: "claude" }]);
  });

  it("mark-complete in the detail header archives the open session and returns to the list", () => {
    const archived: string[] = [];
    const s = makeSession({ id: "s1", title: "Real session" });
    const { deps: d } = deps({
      get: (id) => (id === "s1" ? s : undefined),
      list: () => [s],
      isComplete: () => false,
      initialOpenId: "s1",
      archive: (id) => archived.push(id),
    });
    document.body.append(d.container);
    mountSessionsPanel(d);

    // Detail view is open (terminal mounted); the complete button lives beside
    // the new-session buttons in the header.
    const complete = d.container.querySelector<HTMLButtonElement>(".sess-complete");
    expect(complete).not.toBeNull();
    complete!.click();

    expect(archived).toEqual(["s1"]);
    // Back to the list: the session row is shown, not the terminal detail.
    expect(d.container.querySelector(".sess-terminal")).toBeNull();
    expect(d.container.querySelector(".sess-list")).not.toBeNull();
  });
});

describe("sessionsPanel Terminal/Chat tabs", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  function openDeps(over: Partial<Parameters<typeof mountSessionsPanel>[0]> = {}) {
    const s = makeSession({ id: "s1" });
    const termMounts: string[] = [];
    const { deps: base } = deps({
      list: () => [s],
      get: (id: string) => (id === s.id ? s : undefined),
      initialOpenId: s.id,
      mountTerminal: (_c: HTMLElement, id: string) => {
        termMounts.push(id);
        return () => {};
      },
      ...over,
    });
    return { deps: base, termMounts, session: s };
  }

  it("hides the Chat tab when no mountChat dep is provided", () => {
    const { deps: d } = openDeps();
    document.body.append(d.container);
    mountSessionsPanel(d);
    expect(d.container.querySelector(".chat-tab")).toBeNull();
    expect(d.container.querySelector(".term-tab")).not.toBeNull();
  });

  it("shows the Chat tab and mounts Terminal first (active by default)", () => {
    const { deps: d, termMounts } = openDeps({ mountChat: () => () => {} });
    document.body.append(d.container);
    mountSessionsPanel(d);
    expect(d.container.querySelector(".chat-tab")).not.toBeNull();
    // Terminal is the default active tab and is mounted on open.
    expect(termMounts).toEqual(["s1"]);
    expect(d.container.querySelector<HTMLElement>(".term-tab")?.classList.contains("active")).toBe(
      true,
    );
  });

  it("clicking the Chat tab invokes the injected mountChat with the session", () => {
    const chatMounts: Session[] = [];
    const { deps: d } = openDeps({
      mountChat: (_c: HTMLElement, session: Session) => {
        chatMounts.push(session);
        return () => {};
      },
    });
    document.body.append(d.container);
    mountSessionsPanel(d);

    d.container.querySelector<HTMLButtonElement>(".chat-tab")!.click();

    expect(chatMounts.map((s) => s.id)).toEqual(["s1"]);
    expect(d.container.querySelector<HTMLElement>(".chat-tab")?.classList.contains("active")).toBe(
      true,
    );
  });
});

describe("sessionsPanel scratch terminal", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it("renders the scratch-terminal button when showScratchTerminal is true", async () => {
    await saveSettings({ showScratchTerminal: true });
    const { deps: d } = deps();
    document.body.append(d.container);
    mountSessionsPanel(d);

    expect(d.container.querySelector(".sess-scratch-btn")).not.toBeNull();
  });

  it("omits the scratch-terminal button when showScratchTerminal is false", async () => {
    await saveSettings({ showScratchTerminal: false });
    const { deps: d } = deps();
    document.body.append(d.container);
    mountSessionsPanel(d);

    expect(d.container.querySelector(".sess-scratch-btn")).toBeNull();
  });

  it("refresh() applies a setting change in the list view", async () => {
    await saveSettings({ showScratchTerminal: true });
    const { deps: d } = deps();
    document.body.append(d.container);
    const panel = mountSessionsPanel(d);
    expect(d.container.querySelector(".sess-scratch-btn")).not.toBeNull();

    await saveSettings({ showScratchTerminal: false });
    panel.refresh();

    expect(d.container.querySelector(".sess-scratch-btn")).toBeNull();
  });

  // While a session detail is open, refresh() keeps the live terminal mount
  // (it early-returns rather than re-rendering) — the scratch button must still
  // track the setting, synced in place on the existing header.
  it("refresh() applies a setting change in the detail view without remounting the terminal", async () => {
    await saveSettings({ showScratchTerminal: true });
    const s = makeSession({ id: "s1" });
    const termMounts: string[] = [];
    let disposes = 0;
    const { deps: d } = deps({
      list: () => [s],
      get: (id: string) => (id === s.id ? s : undefined),
      initialOpenId: s.id,
      mountTerminal: (_c: HTMLElement, id: string) => {
        termMounts.push(id);
        return () => {
          disposes += 1;
        };
      },
    });
    document.body.append(d.container);
    const panel = mountSessionsPanel(d);
    expect(d.container.querySelector(".sess-scratch-btn")).not.toBeNull();

    await saveSettings({ showScratchTerminal: false });
    panel.refresh();
    expect(d.container.querySelector(".sess-scratch-btn")).toBeNull();

    await saveSettings({ showScratchTerminal: true });
    panel.refresh();
    expect(d.container.querySelector(".sess-scratch-btn")).not.toBeNull();
    // The header button appears rightmost, after the new-session buttons.
    const head = d.container.querySelector(".sess-head")!;
    expect(head.lastElementChild?.classList.contains("sess-scratch-btn")).toBe(true);

    expect(termMounts).toEqual(["s1"]); // live terminal mounted once, never remounted
    expect(disposes).toBe(0);
  });

  it("clicking it mounts a scratch terminal and creates no session/card", async () => {
    await saveSettings({ showScratchTerminal: true });
    const termMounts: string[] = [];
    const { created, deps: d } = deps({
      mountTerminal: (_c: HTMLElement, id: string) => {
        termMounts.push(id);
        return () => {};
      },
    });
    document.body.append(d.container);
    mountSessionsPanel(d);

    d.container.querySelector<HTMLButtonElement>(".sess-scratch-btn")!.click();

    expect(termMounts).toEqual(["scratch"]);
    expect(created).toEqual([]);
  });
});

describe("sessionsPanel mode-gated surfaces", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  // Build deps for a single open session of the given mode, spying on both mounts.
  function modeDeps(
    mode: Session["mode"],
    over: Partial<Parameters<typeof mountSessionsPanel>[0]> = {},
  ) {
    const s = makeSession({ id: "s1", mode });
    const termMounts: string[] = [];
    const chatMounts: Session[] = [];
    const { deps: base } = deps({
      list: () => [s],
      get: (id: string) => (id === s.id ? s : undefined),
      initialOpenId: s.id,
      mountTerminal: (_c: HTMLElement, id: string) => {
        termMounts.push(id);
        return () => {};
      },
      mountChat: (_c: HTMLElement, session: Session) => {
        chatMounts.push(session);
        return () => {};
      },
      ...over,
    });
    return { deps: base, termMounts, chatMounts, session: s };
  }

  it("gui: shows only Chat — chat mounts, terminal does not, no Terminal tab", () => {
    const { deps: d, termMounts, chatMounts } = modeDeps("gui");
    document.body.append(d.container);
    mountSessionsPanel(d);

    expect(chatMounts.map((s) => s.id)).toEqual(["s1"]);
    expect(termMounts).toEqual([]);
    expect(d.container.querySelector(".term-tab")).toBeNull();
  });

  it("tui: shows only Terminal — terminal mounts, chat does not, no Chat tab", () => {
    const { deps: d, termMounts, chatMounts } = modeDeps("tui");
    document.body.append(d.container);
    mountSessionsPanel(d);

    expect(termMounts).toEqual(["s1"]);
    expect(chatMounts).toEqual([]);
    expect(d.container.querySelector(".chat-tab")).toBeNull();
  });

  it("absent mode: legacy — both tabs present when mountChat provided, terminal active", () => {
    const { deps: d, termMounts } = modeDeps(undefined);
    document.body.append(d.container);
    mountSessionsPanel(d);

    expect(d.container.querySelector(".term-tab")).not.toBeNull();
    expect(d.container.querySelector(".chat-tab")).not.toBeNull();
    expect(termMounts).toEqual(["s1"]);
    expect(d.container.querySelector<HTMLElement>(".term-tab")?.classList.contains("active")).toBe(
      true,
    );
  });

  it("gui without a chat backend: falls back to Terminal with an inline notice", () => {
    const { deps: d, termMounts, chatMounts } = modeDeps("gui", { mountChat: undefined });
    document.body.append(d.container);
    mountSessionsPanel(d);

    expect(termMounts).toEqual(["s1"]);
    expect(chatMounts).toEqual([]);
    expect(d.container.querySelector(".sess-mode-notice")).not.toBeNull();
  });

  // refresh() is wired to the vault change feed and fires on every streamed token.
  // A moded session's fixed surface must NOT be torn down + remounted on refresh,
  // or each token would kill and respawn the live agent/pty pane.
  it("gui: refresh() preserves the live Chat mount (no remount, no dispose)", () => {
    const s = makeSession({ id: "s1", mode: "gui" });
    const chatMounts: Session[] = [];
    let disposes = 0;
    const { deps: base } = deps({
      list: () => [s],
      get: (id: string) => (id === s.id ? s : undefined),
      initialOpenId: s.id,
      mountChat: (_c: HTMLElement, session: Session) => {
        chatMounts.push(session);
        return () => {
          disposes += 1;
        };
      },
    });
    document.body.append(base.container);
    const panel = mountSessionsPanel(base);

    panel.refresh();
    panel.refresh();

    expect(chatMounts.map((m) => m.id)).toEqual(["s1"]); // mounted once, never remounted
    expect(disposes).toBe(0); // live surface never torn down
  });

  it("tui: refresh() preserves the live Terminal mount (no remount, no dispose)", () => {
    const s = makeSession({ id: "s1", mode: "tui" });
    const termMounts: string[] = [];
    let disposes = 0;
    const { deps: base } = deps({
      list: () => [s],
      get: (id: string) => (id === s.id ? s : undefined),
      initialOpenId: s.id,
      mountTerminal: (_c: HTMLElement, id: string) => {
        termMounts.push(id);
        return () => {
          disposes += 1;
        };
      },
    });
    document.body.append(base.container);
    const panel = mountSessionsPanel(base);

    panel.refresh();
    panel.refresh();

    expect(termMounts).toEqual(["s1"]);
    expect(disposes).toBe(0);
  });
});
