import type {
  ChatHarness,
  ChatMessage,
  ChatPart,
  ModelOption,
  PermissionRequest,
  QuestionAnswer,
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
  const toolToggle = button("", "chat-tool-toggle");
  const sendBtn = button("Send", "chat-send");
  bar.append(modelSelect, toolToggle, sendBtn);

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
    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      parts: [{ type: "text", text }],
    };
    store.addMessage(userMsg);
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

  // ---- Tool expand/collapse toggle ----
  // null = each tool uses its own default (expanded except TaskUpdate).
  // true/false = user has forced every tool card open/closed.
  let toolsExpanded: boolean | null = null;
  function toolDefaultOpen(name: string): boolean {
    return name !== "TaskUpdate";
  }
  function updateToggleLabel() {
    // null or true reads as "expanded" — so the button offers to collapse.
    const expandedView = toolsExpanded !== false;
    toolToggle.textContent = expandedView ? "⊟ Collapse tools" : "⊞ Expand tools";
    toolToggle.title = expandedView
      ? "Collapse all tool calls"
      : "Expand all tool calls";
  }
  function applyToolExpansion() {
    if (toolsExpanded == null) return;
    const open = toolsExpanded;
    list.querySelectorAll<HTMLDetailsElement>("details.chat-tool").forEach((d) => {
      d.open = open;
    });
  }
  toolToggle.addEventListener("click", () => {
    toolsExpanded = toolsExpanded === false ? true : false;
    applyToolExpansion();
    updateToggleLabel();
  });
  updateToggleLabel();

  const asObj = (v: unknown): Record<string, unknown> =>
    v && typeof v === "object" ? (v as Record<string, unknown>) : {};

  // Pending AskUserQuestion selections, keyed by the question tool's id, so they
  // survive the full re-render the change feed triggers (the user may pick across
  // several questions before submitting). `null` = that question is unanswered.
  // A toolId is dropped from the map once its answer is submitted/sent.
  const questionSel = new Map<string, (QuestionAnswer | null)[]>();
  const questionBusy = new Set<string>(); // toolIds with an in-flight answer

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
    const input = asObj(part.input);

    // File reads collapse to a single line: Read(path) — no card, no body.
    if (part.name === "Read" && typeof input.file_path === "string") {
      const line = el("div", "chat-tool-line");
      line.textContent = `Read(${input.file_path})`;
      return line;
    }

    const card = el("details", "chat-tool");
    // Expanded by default — except TaskUpdate, which carries only a status and is
    // noise without the task description, so it stays collapsed. Once the user hits
    // the composer toggle, that choice (toolsExpanded) overrides the default.
    card.open = toolsExpanded == null ? toolDefaultOpen(part.name) : toolsExpanded;
    const summary = el("summary", "chat-tool-header");
    const nameEl = el("span", "chat-tool-name");
    nameEl.textContent = part.name;
    const badge = el("span", `chat-tool-badge chat-tool-badge-${part.state}`);
    badge.textContent = part.state;
    summary.append(nameEl, badge);

    // One inset: the body box holds the content; inner blocks add no second box.
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

  // A formatted -/+ diff for edits/writes: the file path then removed (-) and
  // added (+) lines — never a raw JSON block.
  function renderDiff(filePath: unknown, hunks: Array<{ del: unknown; add: unknown }>): HTMLElement {
    const wrap = el("div", "chat-diff");
    if (typeof filePath === "string" && filePath) {
      const f = el("div", "chat-diff-file");
      f.textContent = filePath;
      wrap.append(f);
    }
    for (const h of hunks) {
      const block = el("pre", "chat-diff-block");
      const del = String(h.del ?? "");
      const add = String(h.add ?? "");
      if (del) {
        for (const l of del.split("\n")) {
          const e = el("div", "chat-diff-del");
          e.textContent = `- ${l}`;
          block.append(e);
        }
      }
      if (add) {
        for (const l of add.split("\n")) {
          const e = el("div", "chat-diff-add");
          e.textContent = `+ ${l}`;
          block.append(e);
        }
      }
      wrap.append(block);
    }
    return wrap;
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
    // Edit / MultiEdit / Write: a real -/+ diff, not JSON.
    if (part.name === "Edit" && typeof input.old_string === "string") {
      body.append(renderDiff(input.file_path, [{ del: input.old_string, add: input.new_string }]));
      return;
    }
    if (part.name === "MultiEdit" && Array.isArray(input.edits)) {
      const hunks = input.edits.map((e) => {
        const o = asObj(e);
        return { del: o.old_string, add: o.new_string };
      });
      body.append(renderDiff(input.file_path, hunks));
      return;
    }
    if (part.name === "Write" && typeof input.content === "string") {
      body.append(renderDiff(input.file_path, [{ del: "", add: input.content }]));
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
    // AskUserQuestion: render the question(s) as an interactive answer card.
    if (part.name === "AskUserQuestion" && Array.isArray(input.questions)) {
      body.append(renderQuestionCard(part, input.questions));
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

  interface NormOption {
    label: string;
    description: string;
    preview: string;
  }
  interface NormQuestion {
    header: string;
    question: string;
    multiSelect: boolean;
    options: NormOption[];
  }
  function normalizeQuestion(raw: unknown): NormQuestion {
    const q = asObj(raw);
    const options = (Array.isArray(q.options) ? q.options : []).map((oraw): NormOption => {
      const o = asObj(oraw);
      return {
        label: String(o.label ?? ""),
        description: typeof o.description === "string" ? o.description : "",
        preview: typeof o.preview === "string" ? o.preview : "",
      };
    });
    return {
      header: typeof q.header === "string" ? q.header : "",
      question: String(q.question ?? q.header ?? ""),
      multiSelect: q.multiSelect === true,
      options,
    };
  }

  // The AskUserQuestion answer card. For a mirrored terminal session (the client
  // exposes answerQuestion) it's fully interactive — pick options / toggle
  // multiSelect / type an "Other" answer / decline with "Chat about this" — and
  // submitting drives the live TUI menu via keystrokes. For a session without
  // that capability it falls back to sending the chosen option label as a message.
  function renderQuestionCard(
    part: Extract<ChatPart, { type: "tool" }>,
    rawQuestions: unknown[],
  ): HTMLElement {
    const toolId = part.toolId;
    const qs = rawQuestions.map(normalizeQuestion);
    const live = typeof client.answerQuestion === "function";
    const answered = part.state === "done" || part.state === "error";
    const wrap = el("div", "chat-questions");

    // Shared bits: a question's header chip + text.
    const headerOf = (q: NormQuestion): HTMLElement => {
      const qEl = el("div", "chat-question");
      if (q.header) {
        const chip = el("span", "chat-question-header");
        chip.textContent = q.header;
        qEl.append(chip);
      }
      const qText = el("div", "chat-question-text");
      qText.textContent = q.question;
      qEl.append(qText);
      return qEl;
    };

    // Fallback (no live answer channel): the old behavior — option buttons that
    // send the label as a plain message. Keeps non-mirrored sessions working.
    if (!live) {
      for (const q of qs) {
        const qEl = headerOf(q);
        const optWrap = el("div", "chat-question-options");
        for (const o of q.options) {
          const b = button(o.label, "chat-question-option");
          if (o.description) b.title = o.description;
          b.addEventListener("click", () => void client.send(sessionId, o.label));
          optWrap.append(b);
        }
        qEl.append(optWrap);
        wrap.append(qEl);
      }
      return wrap;
    }

    // Answered: render read-only; the chosen answer shows in the tool output below.
    if (answered) {
      wrap.classList.add("chat-questions-answered");
      for (const q of qs) {
        const qEl = headerOf(q);
        qEl.append(renderOptionsReadonly(q));
        wrap.append(qEl);
      }
      return wrap;
    }

    // ---- Interactive ----
    const sel = ensureSel(toolId, qs.length);
    const busy = questionBusy.has(toolId);
    // A lone single-select question can submit the instant an option is clicked.
    const immediate = qs.length === 1 && !qs[0].multiSelect;

    const submitBtn = button("Submit", "chat-question-submit");
    const chatBtn = button("Chat about this", "chat-question-chat");

    function valid(a: QuestionAnswer | null): boolean {
      if (!a) return false;
      if (a.kind === "multi") return a.indexes.length > 0;
      if (a.kind === "other") return a.text.trim().length > 0;
      return true;
    }
    function refreshSubmit() {
      submitBtn.disabled = busy || !sel.every(valid);
    }

    async function deliver(response: Parameters<NonNullable<typeof client.answerQuestion>>[2]) {
      if (questionBusy.has(toolId)) return;
      questionBusy.add(toolId);
      submitBtn.disabled = true;
      chatBtn.disabled = true;
      try {
        await client.answerQuestion!(sessionId, toolId, response);
        questionSel.delete(toolId); // answered — drop the staged selection
      } catch {
        questionBusy.delete(toolId); // let the user retry
        submitBtn.disabled = false;
        chatBtn.disabled = false;
      }
    }
    function submit() {
      if (!sel.every(valid)) return;
      void deliver({ kind: "submit", answers: sel as QuestionAnswer[] });
    }

    qs.forEach((q, qi) => {
      const qEl = headerOf(q);
      const optWrap = el("div", "chat-question-options");
      // Track this question's single-select buttons so we can move the highlight.
      const optButtons: HTMLButtonElement[] = [];
      const otherInput = el("input", "chat-question-other");
      otherInput.type = "text";
      otherInput.placeholder = "Type your own answer…";

      function clearOptionHighlight() {
        for (const b of optButtons) b.classList.remove("selected");
      }

      q.options.forEach((o, oi) => {
        const row = el("div", "chat-question-option-row");
        const num = el("span", "chat-question-num");
        num.textContent = String(oi + 1);
        row.append(num);

        if (q.multiSelect) {
          const lbl = el("label", "chat-question-check");
          const box = el("input");
          box.type = "checkbox";
          const cur = sel[qi];
          box.checked = cur?.kind === "multi" && cur.indexes.includes(oi);
          box.addEventListener("change", () => {
            const prev = sel[qi];
            const set = new Set(prev?.kind === "multi" ? prev.indexes : []);
            if (box.checked) set.add(oi);
            else set.delete(oi);
            sel[qi] = { kind: "multi", indexes: [...set].sort((a, b) => a - b) };
            refreshSubmit();
          });
          lbl.append(box, optionBody(o));
          row.append(lbl);
        } else {
          const b = el("button", "chat-question-option");
          b.type = "button";
          b.append(optionBody(o));
          const cur = sel[qi];
          if (cur?.kind === "option" && cur.index === oi) b.classList.add("selected");
          b.addEventListener("click", () => {
            otherInput.value = "";
            clearOptionHighlight();
            b.classList.add("selected");
            sel[qi] = { kind: "option", index: oi };
            refreshSubmit();
            if (immediate) submit();
          });
          optButtons.push(b);
          row.append(b);
        }
        optWrap.append(row);
      });

      // "Other" free-text row — typing here selects it (and clears any option pick).
      const cur0 = sel[qi];
      if (cur0?.kind === "other") otherInput.value = cur0.text;
      otherInput.addEventListener("input", () => {
        const text = otherInput.value;
        if (text.trim()) {
          clearOptionHighlight();
          sel[qi] = { kind: "other", text };
        } else if (sel[qi]?.kind === "other") {
          sel[qi] = null;
        }
        refreshSubmit();
      });
      const otherRow = el("div", "chat-question-option-row chat-question-other-row");
      const otherNum = el("span", "chat-question-num");
      otherNum.textContent = String(q.options.length + 1);
      otherRow.append(otherNum, otherInput);
      optWrap.append(otherRow);

      qEl.append(optWrap);
      wrap.append(qEl);
    });

    // Actions: Submit (hidden in immediate mode — a click already submits) + the
    // "Chat about this" escape, which declines and drops focus into the composer.
    const actions = el("div", "chat-question-actions");
    submitBtn.disabled = true;
    submitBtn.addEventListener("click", submit);
    chatBtn.disabled = busy;
    chatBtn.addEventListener("click", () => {
      void deliver({ kind: "chat" });
      input.focus();
    });
    // Submit is always present (a lone single-select also auto-submits on click,
    // but "Other" / multiSelect / multi-question need the explicit button).
    actions.append(submitBtn, chatBtn);
    wrap.append(actions);

    refreshSubmit();
    return wrap;
  }

  // An option's label (with optional description + preview), shared by the
  // interactive and read-only renderers.
  function optionBody(o: { label: string; description: string; preview: string }): HTMLElement {
    const body = el("span", "chat-question-option-body");
    const lab = el("span", "chat-question-option-label");
    lab.textContent = o.label;
    body.append(lab);
    if (o.description) {
      const d = el("span", "chat-question-option-desc");
      d.textContent = o.description;
      body.append(d);
    }
    if (o.preview) {
      const p = el("pre", "chat-question-preview");
      p.textContent = o.preview;
      body.append(p);
    }
    return body;
  }

  function renderOptionsReadonly(q: NormQuestion): HTMLElement {
    const optWrap = el("div", "chat-question-options");
    q.options.forEach((o, oi) => {
      const row = el("div", "chat-question-option-row");
      const num = el("span", "chat-question-num");
      num.textContent = String(oi + 1);
      row.append(num, optionBody(o));
      optWrap.append(row);
    });
    return optWrap;
  }

  // Staged selections for a question tool, created lazily and sized to the
  // question count. Reused across re-renders so picks aren't lost.
  function ensureSel(toolId: string, n: number): (QuestionAnswer | null)[] {
    let s = questionSel.get(toolId);
    if (!s || s.length !== n) {
      s = new Array(n).fill(null);
      questionSel.set(toolId, s);
    }
    return s;
  }

  // ---- Rendering: error (a surfaced pump/driver failure — visibly distinct) ----
  function renderError(part: Extract<ChatPart, { type: "error" }>): HTMLElement {
    const card = el("div", "chat-error-part");
    const icon = el("span", "chat-error-part-icon");
    icon.textContent = "⚠";
    const text = el("span", "chat-error-part-text");
    text.textContent = part.text;
    card.append(icon, text);
    return card;
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
      } else if (part.type === "error") {
        wrap.append(renderError(part));
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
