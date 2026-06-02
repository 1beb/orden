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

  const modelSelect = el("select", "chat-model-select");
  modelSelect.setAttribute("aria-label", "Model");

  // Wrap input + palette so the dropdown can anchor over the input.
  const inputWrap = el("div", "chat-input-wrap");
  const input = el("textarea", "chat-input");
  input.rows = 1;
  input.setAttribute("aria-label", "Message");
  input.placeholder = "Message…";
  const palette = el("div", "chat-command-palette");
  palette.hidden = true;
  inputWrap.append(input, palette);

  const sendBtn = button("Send", "chat-send");

  composer.append(modelSelect, inputWrap, sendBtn);
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
    })
    .catch(() => {
      /* no models available — leave the select empty */
    });

  // ---- Rendering: tool card ----
  function renderToolPart(part: Extract<ChatPart, { type: "tool" }>): HTMLElement {
    const card = el("details", "chat-tool");
    const summary = el("summary", "chat-tool-header");
    const nameEl = el("span", "chat-tool-name");
    nameEl.textContent = part.name;
    const badge = el("span", `chat-tool-badge chat-tool-badge-${part.state}`);
    badge.textContent = part.state;
    summary.append(nameEl, badge);

    const body = el("div", "chat-tool-body");
    const inputPre = el("pre", "chat-tool-input");
    inputPre.textContent = safeStringify(part.input);
    body.append(inputPre);
    if (part.output != null) {
      const outPre = el("pre", "chat-tool-output");
      outPre.textContent = part.output;
      body.append(outPre);
    }
    card.append(summary, body);
    return card;
  }

  function renderMessage(msg: ChatMessage): HTMLElement {
    const wrap = el("div", `chat-msg ${msg.role}`);
    for (const part of msg.parts) {
      if (part.type === "text") {
        const textWrap = el("div", "chat-text");
        textWrap.append(renderMarkdown(part.text));
        wrap.append(textWrap);
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
