// The right pane: a list of AI sessions (claude/opencode). Click a session to
// open it — the embedded agent TUI — with a ← back to the list and a + to start
// a new one. Plain DOM, matching the rest of the app.
import type { Agent, Session } from "./sessions";
import { markFor } from "./agentMarks";
import { loadSettings } from "./settings";

export interface SessionsPanelDeps {
  container: HTMLElement;
  list: () => Session[];
  get: (id: string) => Session | undefined;
  create: (opts: { title: string; agent: Agent }) => Session;
  /** Display name of the project a session belongs to (shown on the card). */
  projectName: (projectId: string) => string;
  /** Mount the agent TUI into container; returns a dispose fn. */
  mountTerminal: (container: HTMLElement, sessionId: string) => () => void;
  /**
   * Mount the native Chat view into container; returns a dispose fn. Optional —
   * when absent (or the host has no chat backend) the Chat tab is hidden and the
   * detail view shows only the Terminal.
   */
  mountChat?: (container: HTMLElement, session: Session) => () => void;
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
  // A `>_` shell prompt glyph for the scratch-terminal affordance.
  terminal: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="5 8 9 12 5 16"/><line x1="12" y1="16" x2="18" y2="16"/></svg>',
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
  // The detail view embeds one of two tabs (Terminal / Chat). We keep the active
  // tab's mount alive across refreshes (don't tear down the live pty/agent on a
  // re-render). `mountedTab`/`mountedSessionId` track what's currently embedded.
  let disposeTab: (() => void) | null = null;
  let mountedSessionId: string | null = null;
  let mountedTab: "terminal" | "chat" | null = null;
  // Which tab the user last chose, persisted across detail re-renders. Terminal
  // is the default.
  let activeTab: "terminal" | "chat" = "terminal";
  // Completed sessions live in a furled bar pinned to the panel bottom; unfurled
  // they expand inline into the scroll list. Default furled.
  let completedOpen = false;
  // The scratch terminal is a TRANSIENT surface — a plain shell, not a session.
  // While open it takes over the panel body; closing returns to the prior view.
  // It never creates a Session record or a card.
  let scratchOpen = false;

  // Assign the open session and remember it, so a reload reopens it.
  function setCurrent(id: string | null): void {
    currentId = id;
    deps.persistOpen?.(id);
  }

  function teardownTab(): void {
    if (disposeTab) {
      try {
        disposeTab();
      } catch {
        /* ignore */
      }
      disposeTab = null;
      mountedSessionId = null;
      mountedTab = null;
    }
  }

  // Start a fresh Untitled session with the chosen agent (it titles itself after
  // the first turn). Drops the session we're leaving if it was never touched.
  function startNewSession(agent: Agent): void {
    teardownTab();
    scratchOpen = false; // a real session replaces the transient scratch shell
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

  // Header affordance for the scratch terminal — only when the setting is on.
  // Opening it parks whatever was showing and takes over the body with a plain
  // shell; it is NOT a session, so no create()/cleanup() runs.
  function scratchButton(): HTMLElement | null {
    if (!loadSettings().showScratchTerminal) return null;
    const b = iconButton(ICON.terminal, "sess-icon sess-scratch-btn");
    b.title = "Open Terminal Only";
    b.setAttribute("aria-label", "Open Terminal Only");
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      scratchOpen = true;
      render();
    });
    return b;
  }

  // The transient scratch shell: a header with a back control and the plain
  // terminal mounted into the body. Closing just clears the flag and re-renders
  // back to the session that was open (or the list).
  function renderScratch(): void {
    teardownTab();
    const c = deps.container;
    c.replaceChildren();

    const head = el("header", "sess-head");
    const back = iconButton(ICON.back, "sess-icon");
    back.title = "Back";
    back.setAttribute("aria-label", "Back");
    back.addEventListener("click", () => {
      teardownTab();
      scratchOpen = false;
      render();
    });
    const title = el("span", "sess-title");
    title.textContent = "Terminal Only";
    head.append(back, title);
    c.append(head);

    const body = el("div", "sess-detail-body sess-scratch-body");
    c.append(body);
    disposeTab = deps.mountTerminal(body, "scratch");
    // A scratch shell is not a session; nothing to track as a mounted surface.
    mountedSessionId = null;
    mountedTab = null;
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
    head.append(collapse, title);
    head.append(newButtons());
    const scratch = scratchButton();
    if (scratch) head.append(scratch); // generic terminal sits rightmost
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
    teardownTab();
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
      teardownTab();
      deps.archive(s.id);
      setCurrent(null);
      render();
    });
    head.append(back, title, complete);
    head.append(newButtons());
    const scratch = scratchButton();
    if (scratch) head.append(scratch); // generic terminal sits rightmost
    c.append(head);
    back.addEventListener("click", () => {
      teardownTab();
      const left = currentId;
      setCurrent(null);
      if (left) deps.cleanup(left); // drop it if it was never touched
      render();
    });

    const chatAvailable = !!deps.mountChat;

    // The set of surfaces this detail offers is fixed by the session's `mode`:
    //   gui → Chat only (or Terminal+notice if the host has no chat backend);
    //   tui → Terminal only;
    //   absent (legacy) → Terminal always, Chat when a chat backend exists, with
    //   the user's last-chosen tab persisted across re-renders.
    // For a single-surface mode the active surface is the mode's surface; only
    // legacy honours the module-level `activeTab`. `guiFallback` marks the case
    // where a GUI session has no chat backend and degrades to the terminal.
    const guiFallback = s.mode === "gui" && !chatAvailable;
    const surfaces: ("terminal" | "chat")[] =
      s.mode === "gui"
        ? chatAvailable
          ? ["chat"]
          : ["terminal"]
        : s.mode === "tui"
          ? ["terminal"]
          : chatAvailable
            ? ["terminal", "chat"]
            : ["terminal"];
    const legacy = s.mode == null;

    // Legacy may carry a persisted "chat" tab that's no longer available; clamp
    // it. Moded sessions ignore `activeTab` entirely — their surface is fixed.
    if (legacy && activeTab === "chat" && !chatAvailable) activeTab = "terminal";
    let current: "terminal" | "chat" = legacy ? activeTab : surfaces[0];

    // Tab bar: only rendered when there's a real choice (legacy with both tabs).
    // Single-surface modes show no tab bar — the surface fills the body.
    const tabs = el("div", "sess-tabs");
    const termTab = button("Terminal", "sess-tab term-tab");
    const chatTab = button("Chat", "sess-tab chat-tab");
    // Legacy preserves today's tab bar exactly (Terminal always shown, even when
    // it's the only surface). Moded sessions are single-surface and show no bar.
    const showTabs = legacy;
    if (showTabs) {
      tabs.append(termTab);
      if (surfaces.includes("chat")) tabs.append(chatTab);
      c.append(tabs);
    }

    // The body host is reused across tab switches: switching tears down the
    // current mount and mounts the other into the same element.
    const body = el("div", "sess-detail-body");
    c.append(body);

    function syncTabButtons(): void {
      termTab.classList.toggle("active", current === "terminal");
      chatTab.classList.toggle("active", current === "chat");
    }

    // Mount the active surface into the body host, tearing down whatever was
    // there. A GUI session with no chat backend mounts the terminal and prepends
    // a one-line notice rather than showing an empty pane.
    function mountActive(): void {
      teardownTab();
      body.replaceChildren();
      if (guiFallback) {
        const notice = el("div", "sess-mode-notice");
        notice.textContent = "GUI unavailable on this host";
        body.append(notice);
      }
      if (current === "chat" && deps.mountChat) {
        disposeTab = deps.mountChat(body, s);
        mountedTab = "chat";
      } else {
        disposeTab = deps.mountTerminal(body, s.id);
        mountedTab = "terminal";
      }
      mountedSessionId = s.id;
      syncTabButtons();
    }

    // Only legacy sessions can switch surfaces; the toggle persists the choice
    // across re-renders via the module-level `activeTab`.
    function switchTo(tab: "terminal" | "chat"): void {
      if (current === tab && mountedSessionId === s.id) return;
      current = tab;
      activeTab = tab;
      mountActive();
    }
    termTab.addEventListener("click", () => switchTo("terminal"));
    chatTab.addEventListener("click", () => switchTo("chat"));

    mountActive();
  }

  // Sync the scratch affordance with its setting on an already-rendered header,
  // for the refresh paths that keep the live mount instead of re-rendering. The
  // button sits rightmost in the header, so append lands it in the right spot.
  function syncScratchButton(): void {
    const head = deps.container.querySelector<HTMLElement>("header.sess-head");
    if (!head) return;
    const existing = head.querySelector<HTMLElement>(".sess-scratch-btn");
    if (loadSettings().showScratchTerminal) {
      if (!existing) {
        const b = scratchButton();
        if (b) head.append(b);
      }
    } else {
      existing?.remove();
    }
  }

  // The surface a session's detail would currently show, so a refresh can tell
  // whether the live mount is still correct without re-rendering. For moded
  // sessions the surface is fixed by `mode` (GUI w/o a chat backend degrades to
  // the terminal); legacy follows the persisted `activeTab`, clamped to what the
  // host can provide.
  function expectedSurface(s: Session): "terminal" | "chat" {
    if (s.mode === "gui") return deps.mountChat ? "chat" : "terminal";
    if (s.mode === "tui") return "terminal";
    return activeTab === "chat" && deps.mountChat ? "chat" : "terminal";
  }

  function render(): void {
    // The scratch shell overrides the normal list/detail view while open.
    // Keep its live pty across refresh ticks (the change feed fires often) —
    // only mount it the first time, like the session surfaces above.
    if (scratchOpen) {
      if (disposeTab && mountedSessionId === null) return;
      renderScratch();
      return;
    }
    const s = currentId ? deps.get(currentId) : undefined;
    if (s) {
      // keep the active surface's mount alive across refreshes (don't tear down
      // the live pty/agent) when it's already showing this session's surface.
      if (disposeTab && mountedSessionId === s.id && mountedTab === expectedSurface(s)) {
        syncScratchButton();
        return;
      }
      renderDetail(s);
    } else {
      // A restored id whose session is gone (deleted/cleaned) — fall back to the
      // list and forget it, so we don't keep trying to reopen a dead session.
      if (currentId !== null) setCurrent(null);
      teardownTab();
      renderList();
    }
  }

  render();
  return {
    refresh: render,
    open: (id: string) => {
      // Selecting a real session leaves the transient scratch shell.
      if (scratchOpen) {
        teardownTab();
        scratchOpen = false;
      }
      setCurrent(id);
      render();
    },
  };
}
