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
});
