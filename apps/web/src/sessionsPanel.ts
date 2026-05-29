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
  let composingNew = false;

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
      composingNew = !composingNew;
      renderList();
    });

    if (composingNew) {
      const form = el("div", "sess-newform");
      const name = document.createElement("input");
      name.className = "sess-input";
      name.placeholder = "Session title";
      const agent = document.createElement("select");
      agent.className = "settings-select";
      for (const a of ["claude", "opencode"] as Agent[]) {
        const o = document.createElement("option");
        o.value = a;
        o.textContent = a;
        agent.append(o);
      }
      const create = button("Create", "sess-create");
      const submit = () => {
        const s = deps.create({ title: name.value.trim() || "New session", agent: agent.value as Agent });
        composingNew = false;
        currentId = s.id;
        render();
      };
      create.addEventListener("click", submit);
      name.addEventListener("keydown", (e) => {
        if (e.key === "Enter") submit();
      });
      form.append(name, agent, create);
      c.append(form);
      name.focus();
    }

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
      currentId = null;
      render();
    });

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
    if (s) renderDetail(s);
    else renderList();
  }

  render();
  return { refresh: render };
}
