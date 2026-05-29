// The right pane: a list of AI sessions (claude/opencode). Click a session to
// open it — transcript + a commentary box to message the agent — with a ← back
// to the list and a + to start a new one. Plain DOM, matching the rest of the app.
import type { Agent, Session } from "./sessions";

export interface SessionsPanelDeps {
  container: HTMLElement;
  list: () => Session[];
  get: (id: string) => Session | undefined;
  create: (opts: { title: string; agent: Agent }) => Session;
  send: (id: string, text: string) => void;
  /** "chat" = transcript + commentary; "terminal" = embedded agent TUI. */
  mode: () => "chat" | "terminal";
  /** Mount the agent TUI into container; returns a dispose fn. */
  mountTerminal: (container: HTMLElement, sessionId: string) => () => void;
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

export function mountSessionsPanel(deps: SessionsPanelDeps): SessionsPanel {
  let currentId: string | null = null;
  let disposeTerm: (() => void) | null = null;
  let termSessionId: string | null = null;

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

  function renderList(): void {
    const c = deps.container;
    c.replaceChildren();

    const head = el("header", "sess-head");
    const title = el("span", "sess-title");
    title.textContent = "Sessions";
    const newBtn = button("+", "sess-icon");
    newBtn.title = "New session";
    head.append(title, newBtn);
    c.append(head);
    newBtn.addEventListener("click", () => {
      // No name prompt — start Untitled; the agent titles it after the first turn.
      const s = deps.create({ title: "Untitled", agent: "claude" });
      currentId = s.id;
      render();
    });

    const sessions = deps.list();
    if (sessions.length === 0) {
      const empty = el("div", "sess-empty");
      empty.textContent = "No sessions yet — start one with +.";
      c.append(empty);
      return;
    }
    const ul = el("ul", "sess-list");
    for (const s of sessions) {
      const li = el("li", "sess-item");
      const t = el("span", "sess-item-title");
      t.textContent = s.title;
      const badge = el("span", "sess-badge");
      badge.textContent = s.agent;
      li.append(t, badge);
      li.addEventListener("click", () => {
        currentId = s.id;
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
    const back = button("←", "sess-icon");
    back.title = "Back to sessions";
    const title = el("span", "sess-title");
    title.textContent = s.title;
    const badge = el("span", "sess-badge");
    badge.textContent = s.agent;
    head.append(back, title, badge);
    c.append(head);
    back.addEventListener("click", () => {
      teardownTerm();
      currentId = null;
      render();
    });

    // Terminal mode: embed the real agent TUI instead of the chat transcript.
    if (deps.mode() === "terminal") {
      const termHost = el("div", "sess-terminal");
      c.append(termHost);
      disposeTerm = deps.mountTerminal(termHost, s.id);
      termSessionId = s.id;
      return;
    }

    const transcript = el("div", "sess-transcript");
    if (s.messages.length === 0) {
      const e = el("div", "sess-empty");
      e.textContent = `No messages yet — say something to ${s.agent} below.`;
      transcript.append(e);
    }
    for (const m of s.messages) {
      const msg = el("div", `sess-msg sess-msg-${m.role}`);
      msg.textContent = m.text;
      transcript.append(msg);
    }
    c.append(transcript);

    const box = el("div", "sess-commentary");
    const ta = document.createElement("textarea");
    ta.className = "sess-input-box";
    ta.rows = 2;
    ta.placeholder = `Message ${s.agent}…  (⌘/Ctrl+Enter)`;
    const sendBtn = button("Send", "panel-send");
    sendBtn.dataset.kind = "send";
    box.append(ta, sendBtn);
    c.append(box);
    const submit = () => {
      const text = ta.value.trim();
      if (!text) return;
      deps.send(s.id, text);
      ta.value = "";
      render();
    };
    sendBtn.addEventListener("click", submit);
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        submit();
      }
    });
    transcript.scrollTop = transcript.scrollHeight;
  }

  function render(): void {
    const s = currentId ? deps.get(currentId) : undefined;
    if (s) {
      // keep a live terminal mounted across refreshes (don't tear down the pty)
      if (deps.mode() === "terminal" && disposeTerm && termSessionId === s.id) return;
      renderDetail(s);
    } else {
      teardownTerm();
      renderList();
    }
  }

  render();
  return { refresh: render };
}
