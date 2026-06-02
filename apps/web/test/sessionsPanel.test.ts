import { describe, it, expect, beforeEach } from "vitest";
import { mountSessionsPanel } from "../src/sessionsPanel";
import type { Agent, Session } from "../src/sessions";

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
