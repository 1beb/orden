import type {
  ChatHarness,
  ChatMessage,
  ChatPart,
  ModelOption,
  PermissionRequest,
  SlashCommand,
} from "@orden/chat-core";
import type { ChatStore } from "./chatStore";
import type { ChatClient } from "./client";

export interface ChatViewOpts {
  container: HTMLElement;
  store: ChatStore;
  client: ChatClient;
  sessionId: string;
  harness: ChatHarness;
  // Injected so chat-ui carries no markdown lib. Returns a safe DOM node for a text part.
  renderMarkdown: (text: string) => Node;
}

// Tiny framework-free element helpers. chat-ui is standalone — these intentionally
// duplicate apps/web's `el`/`button` rather than importing them.
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}

function button(text: string, cls: string): HTMLButtonElement {
  const b = el("button", cls);
  b.type = "button";
  b.textContent = text;
  return b;
}

export function mountChatView(opts: ChatViewOpts): { dispose(): void } {
  const { container, store, client, sessionId, harness, renderMarkdown } = opts;

  // ---- DOM skeleton ----
  const root = el("div", "chat-view");
  const list = el("div", "chat-messages"); // scrollable message list
  const permArea = el("div", "chat-permissions");
  const composer = el("div", "chat-composer");

  // Composer layout: a big message box on top, then a bottom bar with the model
  // picker bottom-left and Send bottom-right.
  const inputWrap = el("div", "chat-input-wrap");
  const input = el("textarea", "chat-input");
  input.rows = 3;
  input.setAttribute("aria-label", "Message");
  input.placeholder = "Message…";
  const palette = el("div", "chat-command-palette");
  palette.hidden = true;
  inputWrap.append(input, palette);

  const bar = el("div", "chat-composer-bar");
  const modelSelect = el("select", "chat-model-select");
  modelSelect.setAttribute("aria-label", "Model");
  const sendBtn = button("Send", "chat-send");
  bar.append(modelSelect, sendBtn);

  composer.append(inputWrap, bar);
  root.append(list, permArea, composer);
  container.append(root);

  // ---- Slash command palette state (commands fetched lazily on first '/') ----
  let commands: SlashCommand[] | null = null;
  let commandsFetched = false;

  function renderPalette() {
    palette.replaceChildren();
    const text = input.value;
    if (!text.startsWith("/") || !commands) {
      palette.hidden = true;
      return;
    }
    const prefix = text.slice(1).toLowerCase();
    const matches = commands.filter((c) => c.name.toLowerCase().startsWith(prefix));
    if (matches.length === 0) {
      palette.hidden = true;
      return;
    }
    for (const cmd of matches) {
      const item = button(`/${cmd.name}`, "chat-command-item");
      if (cmd.description) item.title = cmd.description;
      item.addEventListener("click", () => {
        // Fill (safer than auto-send) and let the user edit/submit.
        input.value = `/${cmd.name} `;
        palette.hidden = true;
        input.focus();
      });
      palette.append(item);
    }
    palette.hidden = false;
  }

  function onInput() {
    if (input.value.startsWith("/") && !commandsFetched) {
      commandsFetched = true;
      void client
        .listCommands(sessionId)
        .then((cmds) => {
          commands = cmds;
          renderPalette();
        })
        .catch(() => {
          commands = [];
        });
    }
    renderPalette();
  }
  input.addEventListener("input", onInput);

  // ---- Composer send ----
  function doSend() {
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    palette.hidden = true;
    void client.send(sessionId, text);
  }
  sendBtn.addEventListener("click", doSend);
  input.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      doSend();
    }
  });

  // ---- Model picker ----
  modelSelect.addEventListener("change", () => {
    if (modelSelect.value) void client.setModel(sessionId, modelSelect.value);
  });
  void client
    .listModels(harness)
    .then((models: ModelOption[]) => {
      modelSelect.replaceChildren();
      for (const m of models) {
        const opt = el("option");
        opt.value = m.id;
        opt.textContent = m.label;
        modelSelect.append(opt);
      }
      // No models (e.g. a mirrored terminal session owns its own model) — hide
      // the picker rather than show an empty dropdown.
      modelSelect.hidden = models.length === 0;
    })
    .catch(() => {
      modelSelect.hidden = true;
    });

  const asObj = (v: unknown): Record<string, unknown> =>
    v && typeof v === "object" ? (v as Record<string, unknown>) : {};

  // ---- Rendering: thinking (not collapsible — always shown) ----
  function renderThinking(part: Extract<ChatPart, { type: "thinking" }>): HTMLElement {
    const card = el("div", "chat-thinking");
    const header = el("div", "chat-thinking-header");
    const label = el("span", "chat-thinking-label");
    label.textContent = "✻ Thinking";
    header.append(label);
    if (part.tokens != null) {
      const meta = el("span", "chat-thinking-meta");
      meta.textContent = `${part.tokens} tokens`;
      header.append(meta);
    }
    const body = el("div", "chat-thinking-body");
    body.append(renderMarkdown(part.text));
    card.append(header, body);
    return card;
  }

  // ---- Rendering: tool card (visible/expanded by default — don't hide) ----
  function renderToolPart(part: Extract<ChatPart, { type: "tool" }>): HTMLElement {
    const card = el("details", "chat-tool");
    // Expanded by default — except TaskUpdate, which carries only a status and is
    // noise without the task description, so it stays collapsed.
    card.open = part.name !== "TaskUpdate";
    const summary = el("summary", "chat-tool-header");
    const nameEl = el("span", "chat-tool-name");
    nameEl.textContent = part.name;
    const badge = el("span", `chat-tool-badge chat-tool-badge-${part.state}`);
    badge.textContent = part.state;
    summary.append(nameEl, badge);

    const body = el("div", "chat-tool-body");
    renderToolInput(body, part);
    if (part.output != null && part.output !== "") {
      const outPre = el("pre", "chat-tool-output");
      outPre.textContent = part.output;
      body.append(outPre);
    }
    card.append(summary, body);
    return card;
  }

  function renderToolInput(body: HTMLElement, part: Extract<ChatPart, { type: "tool" }>): void {
    const input = asObj(part.input);
    // Bash: show the command as `$ …` monospace, with its description below.
    if (part.name === "Bash" && typeof input.command === "string") {
      const pre = el("pre", "chat-tool-cmd");
      pre.textContent = `$ ${input.command}`;
      body.append(pre);
      if (typeof input.description === "string" && input.description) {
        const d = el("div", "chat-tool-desc");
        d.textContent = input.description;
        body.append(d);
      }
      return;
    }
    // TodoWrite / TaskCreate: show the task list / description, not raw JSON.
    if (part.name === "TodoWrite" && Array.isArray(input.todos)) {
      body.append(renderTodos(input.todos));
      return;
    }
    if (part.name === "TaskCreate") {
      const t = el("div", "chat-task");
      const subj = el("div", "chat-task-subject");
      subj.textContent = String(input.subject ?? "task");
      t.append(subj);
      if (typeof input.description === "string" && input.description) {
        const d = el("div", "chat-task-desc");
        d.textContent = input.description;
        t.append(d);
      }
      body.append(t);
      return;
    }
    // AskUserQuestion: render the question(s) + selectable options.
    if (part.name === "AskUserQuestion" && Array.isArray(input.questions)) {
      body.append(renderQuestions(input.questions));
      return;
    }
    // Generic: pretty-printed JSON input.
    const inputPre = el("pre", "chat-tool-input");
    inputPre.textContent = safeStringify(part.input);
    body.append(inputPre);
  }

  function renderTodos(todos: unknown[]): HTMLElement {
    const ul = el("ul", "chat-todos");
    for (const raw of todos) {
      const t = asObj(raw);
      const status = String(t.status ?? "pending");
      const li = el("li", `chat-todo chat-todo-${status}`);
      const mark = el("span", "chat-todo-mark");
      mark.textContent = status === "completed" ? "✓" : status === "in_progress" ? "▸" : "○";
      const txt = el("span", "chat-todo-text");
      txt.textContent = String(t.content ?? t.activeForm ?? "");
      li.append(mark, txt);
      ul.append(li);
    }
    return ul;
  }

  function renderQuestions(questions: unknown[]): HTMLElement {
    const wrap = el("div", "chat-questions");
    for (const raw of questions) {
      const q = asObj(raw);
      const qEl = el("div", "chat-question");
      const qText = el("div", "chat-question-text");
      qText.textContent = String(q.question ?? q.header ?? "");
      qEl.append(qText);
      const optWrap = el("div", "chat-question-options");
      const opts = Array.isArray(q.options) ? q.options : [];
      for (const oraw of opts) {
        const o = asObj(oraw);
        const label = String(o.label ?? "");
        const b = button(label, "chat-question-option");
        if (typeof o.description === "string" && o.description) b.title = o.description;
        // Live session: clicking sends the chosen label as the answer.
        b.addEventListener("click", () => void client.send(sessionId, label));
        optWrap.append(b);
      }
      qEl.append(optWrap);
      wrap.append(qEl);
    }
    return wrap;
  }

  function renderMessage(msg: ChatMessage): HTMLElement {
    const wrap = el("div", `chat-msg ${msg.role}`);
    for (const part of msg.parts) {
      if (part.type === "text") {
        const textWrap = el("div", "chat-text");
        textWrap.append(renderMarkdown(part.text));
        wrap.append(textWrap);
      } else if (part.type === "thinking") {
        wrap.append(renderThinking(part));
      } else {
        wrap.append(renderToolPart(part));
      }
    }
    return wrap;
  }

  function renderMessages() {
    list.replaceChildren();
    for (const msg of store.messages()) list.append(renderMessage(msg));
    list.scrollTop = list.scrollHeight;
  }

  // ---- Rendering: permissions ----
  function renderPermissions() {
    permArea.replaceChildren();
    for (const req of store.pendingPermissions()) permArea.append(renderPermission(req));
  }

  function renderPermission(req: PermissionRequest): HTMLElement {
    const card = el("div", "chat-perm");
    const title = el("div", "chat-perm-title");
    title.textContent = req.title;
    const tool = el("div", "chat-perm-tool");
    tool.textContent = req.toolName;
    const actions = el("div", "chat-perm-actions");
    const allow = button("Allow", "chat-perm-allow");
    const deny = button("Deny", "chat-perm-deny");
    function respond(decision: "allow" | "deny") {
      allow.disabled = true;
      deny.disabled = true;
      void client.respondPermission(sessionId, req.id, { decision });
    }
    allow.addEventListener("click", () => respond("allow"));
    deny.addEventListener("click", () => respond("deny"));
    actions.append(allow, deny);
    card.append(title, tool, actions);
    return card;
  }

  // ---- Subscribe + initial paint ----
  function rerender() {
    renderMessages();
    renderPermissions();
  }
  const unsubscribe = store.onChange(rerender);
  rerender();

  return {
    dispose() {
      unsubscribe();
      container.replaceChildren();
    },
  };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}
