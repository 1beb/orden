import { describe, it, expect, beforeEach } from "vitest";
import { mountSessionsPanel } from "../src/sessionsPanel";
import type { Agent, Session } from "../src/sessions";

function makeSession(over: Partial<Session> = {}): Session {
  return {
    id: "s1",
    title: "Untitled",
    agent: "claude",
    projectId: "p1",
    messages: [],
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
    send: () => {},
    projectName: () => "Homeroom",
    mode: () => "chat" as const,
    mountTerminal: () => () => {},
    archive: () => {},
    remove: () => {},
    cleanup: () => {},
  };
  return { created, deps: { ...base, ...over } };
}

describe("sessionsPanel new-session agent picker", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it("the + button opens a menu offering both Claude and opencode", () => {
    const { deps: d } = deps();
    document.body.append(d.container);
    mountSessionsPanel(d);

    const plus = d.container.querySelector<HTMLButtonElement>(".sess-icon")!;
    plus.click();

    const items = [...d.container.querySelectorAll(".sess-menu-item")].map((n) => n.textContent);
    expect(items).toEqual(["Claude", "opencode"]);
  });

  it("picking opencode creates a session with agent=opencode", () => {
    const { created, deps: d } = deps();
    document.body.append(d.container);
    mountSessionsPanel(d);

    d.container.querySelector<HTMLButtonElement>(".sess-icon")!.click();
    const opencode = [...d.container.querySelectorAll<HTMLButtonElement>(".sess-menu-item")].find(
      (b) => b.textContent === "opencode",
    )!;
    opencode.click();

    expect(created).toEqual([{ title: "Untitled", agent: "opencode" }]);
  });

  it("picking Claude creates a session with agent=claude", () => {
    const { created, deps: d } = deps();
    document.body.append(d.container);
    mountSessionsPanel(d);

    d.container.querySelector<HTMLButtonElement>(".sess-icon")!.click();
    const claude = [...d.container.querySelectorAll<HTMLButtonElement>(".sess-menu-item")].find(
      (b) => b.textContent === "Claude",
    )!;
    claude.click();

    expect(created).toEqual([{ title: "Untitled", agent: "claude" }]);
  });
});
