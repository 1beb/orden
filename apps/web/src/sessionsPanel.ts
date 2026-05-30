// The right pane: a list of AI sessions (claude/opencode). Click a session to
// open it — the embedded agent TUI — with a ← back to the list and a + to start
// a new one. Plain DOM, matching the rest of the app.
import type { Agent, Session } from "./sessions";

// Brand marks for the new-session badges, embedded as inline SVG. Both use
// fill="currentColor" so they inherit the pill's text color (lavender →
// white on hover). Static, author-authored literals.
//
// Claude "sunburst" mark — source: simple-icons (icons/claude.svg).
// https://github.com/simple-icons/simple-icons
const CLAUDE_MARK =
  '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" focusable="false">' +
  '<path fill="currentColor" d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z"/>' +
  "</svg>";

// opencode square mark — nested rectangles forming an "O". Source: official
// opencode brand assets (opencode.ai/brand), recolored to currentColor.
// Original viewBox 240x300; outer frame fills, inner rect is cut out via
// fill-rule so the mark inherits one color and reads at small sizes.
const OPENCODE_MARK =
  '<svg viewBox="0 0 240 300" width="13" height="16" aria-hidden="true" focusable="false">' +
  '<path fill="currentColor" fill-rule="evenodd" d="M0 0h240v300H0V0Zm60 60v180h120V60H60Z"/>' +
  "</svg>";

export interface SessionsPanelDeps {
  container: HTMLElement;
  list: () => Session[];
  get: (id: string) => Session | undefined;
  create: (opts: { title: string; agent: Agent }) => Session;
  /** Display name of the project a session belongs to (shown on the card). */
  projectName: (projectId: string) => string;
  /** Mount the agent TUI into container; returns a dispose fn. */
  mountTerminal: (container: HTMLElement, sessionId: string) => () => void;
  /** Archive a session (move it to Done / out of the active list). */
  archive: (id: string) => void;
  /** Permanently delete a session. */
  remove: (id: string) => void;
  /** Drop a session if it was abandoned untouched (no-op otherwise). */
  cleanup: (id: string) => void;
  /** The session that was open last run, to reopen on boot (null = the list). */
  initialOpenId?: string | null;
  /** Persist which session is open so a reload reopens it. */
  persistOpen?: (id: string | null) => void;
}

export interface SessionsPanel {
  refresh(): void;
}

function el(tag: string, cls?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}
function button(text: string, cls: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = cls;
  b.textContent = text;
  return b;
}
// Inline-SVG icons (stroke = currentColor) instead of Unicode glyphs — text
// glyphs (← ✓ ✕ ☰ ⌕) substitute to a condensed face in fonts that lack them,
// which renders "compressed" (notably in Firefox). SVG is font/OS-independent.
const ICON = {
  back: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>',
  check: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>',
  x: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>',
} as const;
function iconButton(svg: string, cls: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = cls;
  b.innerHTML = svg; // static, author-controlled literal
  return b;
}
function markFor(agent: Agent): string {
  return agent === "opencode" ? OPENCODE_MARK : CLAUDE_MARK;
}
// A small read-only pill showing which agent a session belongs to, using the
// same brand mark as the new-session buttons (no letter abbreviations).
function agentBadge(agent: Agent): HTMLElement {
  const b = el("span", "sess-badge");
  b.innerHTML = markFor(agent);
  b.title = agent;
  return b;
}

export function mountSessionsPanel(deps: SessionsPanelDeps): SessionsPanel {
  let currentId: string | null = deps.initialOpenId ?? null;
  let disposeTerm: (() => void) | null = null;
  let termSessionId: string | null = null;

  // Assign the open session and remember it, so a reload reopens it.
  function setCurrent(id: string | null): void {
    currentId = id;
    deps.persistOpen?.(id);
  }

  function teardownTerm(): void {
    if (disposeTerm) {
      try {
        disposeTerm();
      } catch {
        /* ignore */
      }
      disposeTerm = null;
      termSessionId = null;
    }
  }

  // Start a fresh Untitled session with the chosen agent (it titles itself after
  // the first turn). Drops the session we're leaving if it was never touched.
  function startNewSession(agent: Agent): void {
    teardownTerm();
    const leaving = currentId;
    const s = deps.create({ title: "Untitled", agent });
    setCurrent(s.id);
    if (leaving) deps.cleanup(leaving);
    render();
  }

  // One clickable badge per agent — click to spawn a new session with that agent
  // directly. No dropdown: the agent IS the affordance. Each badge shows the
  // brand's official mark as an inline SVG (Claude sunburst, opencode square).
  function newButtons(): HTMLElement {
    const wrap = el("span", "sess-new");
    const agentBtn = (svg: string, agent: Agent, name: string): HTMLButtonElement => {
      const b = button("", "sess-agent-btn");
      // Static, author-controlled SVG literals — safe to set as markup.
      b.innerHTML = svg;
      b.title = `New ${name} session`;
      b.setAttribute("aria-label", `New ${name} session`);
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        startNewSession(agent);
      });
      return b;
    };
    wrap.append(
      agentBtn(markFor("claude"), "claude", "Claude"),
      agentBtn(markFor("opencode"), "opencode", "opencode"),
    );
    return wrap;
  }

  function renderList(): void {
    const c = deps.container;
    c.replaceChildren();

    const head = el("header", "sess-head");
    const title = el("span", "sess-title");
    title.textContent = "Sessions";
    head.append(title, newButtons());
    c.append(head);

    const sessions = deps.list();
    if (sessions.length === 0) {
      const empty = el("div", "sess-empty");
      empty.textContent = "No sessions yet — start one with +.";
      c.append(empty);
      return;
    }
    const ul = el("ul", "sess-list");
    for (const s of sessions) {
      const li = el("li", "sess-card");
      if (s.archived) li.classList.add("archived");

      const main = el("div", "sess-card-main");
      const t = el("div", "sess-card-title");
      t.textContent = s.title;
      const proj = el("div", "sess-card-proj");
      proj.textContent = deps.projectName(s.projectId);
      main.append(t, proj);

      const badge = agentBadge(s.agent);
      const archive = iconButton(ICON.check, "sess-rowbtn");
      archive.title = "Archive (move to Done)";
      archive.setAttribute("aria-label", "Archive (move to Done)");
      archive.addEventListener("click", (e) => {
        e.stopPropagation();
        deps.archive(s.id);
        renderList();
      });
      const del = iconButton(ICON.x, "sess-rowbtn");
      del.title = "Delete session";
      del.setAttribute("aria-label", "Delete session");
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        deps.remove(s.id);
        renderList();
      });
      li.append(main, badge, archive, del);
      li.addEventListener("click", () => {
        setCurrent(s.id);
        render();
      });
      ul.append(li);
    }
    c.append(ul);
  }

  function renderDetail(s: Session): void {
    teardownTerm();
    const c = deps.container;
    c.replaceChildren();

    const head = el("header", "sess-head");
    const back = iconButton(ICON.back, "sess-icon");
    back.title = "Back to sessions";
    back.setAttribute("aria-label", "Back to sessions");
    const title = el("span", "sess-title");
    title.textContent = s.title;
    // No agent badge in the detail view — you already know which agent you're in.
    head.append(back, title, newButtons());
    c.append(head);
    back.addEventListener("click", () => {
      teardownTerm();
      const left = currentId;
      setCurrent(null);
      if (left) deps.cleanup(left); // drop it if it was never touched
      render();
    });

    // Embed the real agent TUI.
    const termHost = el("div", "sess-terminal");
    c.append(termHost);
    disposeTerm = deps.mountTerminal(termHost, s.id);
    termSessionId = s.id;
  }

  function render(): void {
    const s = currentId ? deps.get(currentId) : undefined;
    if (s) {
      // keep a live terminal mounted across refreshes (don't tear down the pty)
      if (disposeTerm && termSessionId === s.id) return;
      renderDetail(s);
    } else {
      // A restored id whose session is gone (deleted/cleaned) — fall back to the
      // list and forget it, so we don't keep trying to reopen a dead session.
      if (currentId !== null) setCurrent(null);
      teardownTerm();
      renderList();
    }
  }

  render();
  return { refresh: render };
}
