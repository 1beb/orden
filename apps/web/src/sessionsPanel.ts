// The right pane: a list of AI sessions (claude/opencode). Click a session to
// open it — the embedded agent TUI — with a ← back to the list and a + to start
// a new one. Plain DOM, matching the rest of the app.
import type { Agent, Session } from "./sessions";
import { markFor } from "./agentMarks";

export interface SessionsPanelDeps {
  container: HTMLElement;
  list: () => Session[];
  get: (id: string) => Session | undefined;
  create: (opts: { title: string; agent: Agent }) => Session;
  /** Display name of the project a session belongs to (shown on the card). */
  projectName: (projectId: string) => string;
  /** Mount the agent TUI into container; returns a dispose fn. */
  mountTerminal: (container: HTMLElement, sessionId: string) => () => void;
  /** True if a session is done (its linked card reached Complete) — furled below. */
  isComplete: (id: string) => boolean;
  /** Archive a session (move it to Done / out of the active list). */
  archive: (id: string) => void;
  /** Permanently delete a session. */
  remove: (id: string) => void;
  /** Drop a session if it was abandoned untouched (no-op otherwise). */
  cleanup: (id: string) => void;
  /** Collapse the panel (mobile: dismiss the full-width slide-over). */
  close: () => void;
  /** The session that was open last run, to reopen on boot (null = the list). */
  initialOpenId?: string | null;
  /** Persist which session is open so a reload reopens it. */
  persistOpen?: (id: string | null) => void;
}

export interface SessionsPanel {
  refresh(): void;
  /** Open a specific session in the panel (e.g. just created from a card). */
  open(id: string): void;
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
  collapse: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 6 15 12 9 18"/></svg>',
} as const;
function iconButton(svg: string, cls: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = cls;
  b.innerHTML = svg; // static, author-controlled literal
  return b;
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
  // Completed sessions live in a furled bar pinned to the panel bottom; unfurled
  // they expand inline into the scroll list. Default furled.
  let completedOpen = false;

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
    // Mobile-only: the pane is a full-width slide-over that hides the topbar's
    // pane toggle, so the list view needs its own way back to the document.
    const collapse = iconButton(ICON.collapse, "sess-icon sess-collapse");
    collapse.title = "Close sessions";
    collapse.setAttribute("aria-label", "Close sessions");
    collapse.addEventListener("click", () => deps.close());
    head.append(collapse, title, newButtons());
    c.append(head);

    const sessions = deps.list();
    if (sessions.length === 0) {
      const empty = el("div", "sess-empty");
      empty.textContent = "No sessions yet — start one with +.";
      c.append(empty);
      return;
    }

    // One row per session, reused by the active list and the furled Completed
    // section below.
    function sessionRow(s: Session): HTMLLIElement {
      const li = el("li", "sess-card") as HTMLLIElement;
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
      return li;
    }

    // Done sessions (their linked card reached Complete) move out of the active
    // list. Furled, the header is a bar pinned to the panel bottom; unfurled, it
    // becomes an inline header row and the done rows scroll with the active list.
    const active = sessions.filter((s) => !deps.isComplete(s.id));
    const completed = sessions.filter((s) => deps.isComplete(s.id));

    function doneHeader(tag: string): HTMLElement {
      const h = el(tag, "sess-done-head");
      if (completedOpen) h.classList.add("open");
      const caret = el("span", "sess-done-caret");
      const label = el("span", "sess-done-label");
      label.textContent = `Completed (${completed.length})`;
      h.append(caret, label);
      h.addEventListener("click", () => {
        completedOpen = !completedOpen;
        renderList();
      });
      return h;
    }

    const ul = el("ul", "sess-list");
    for (const s of active) ul.append(sessionRow(s));
    // Unfurled: header row + done rows append to the scroll list.
    if (completed.length && completedOpen) {
      ul.append(doneHeader("li"));
      for (const s of completed) ul.append(sessionRow(s));
    }
    c.append(ul);

    // Furled: a bar pinned to the bottom of the panel (sibling after the list).
    if (completed.length && !completedOpen) {
      const footer = doneHeader("div");
      footer.classList.add("pinned");
      c.append(footer);
    }
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
    // Mark-complete sits beside the new-session buttons: finish the open session
    // (flips its linked card to Complete, furls it below) and drop back to the
    // list. Only meaningful here, where "the session" is unambiguously this one.
    const complete = iconButton(ICON.check, "sess-icon sess-complete");
    complete.title = "Mark session complete";
    complete.setAttribute("aria-label", "Mark session complete");
    complete.addEventListener("click", () => {
      teardownTerm();
      deps.archive(s.id);
      setCurrent(null);
      render();
    });
    head.append(back, title, complete, newButtons());
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
  return {
    refresh: render,
    open: (id: string) => {
      setCurrent(id);
      render();
    },
  };
}
