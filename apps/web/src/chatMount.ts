// Mount the native Chat tab (the @orden/chat-ui view) for a panel session.
//
// PREFERRED PATH — terminal mirror: if the session can be mirrored (a claude
// session with a transcript), the Chat tab shows the SAME conversation the
// Terminal tab runs (host.terminalChat.mirror parses its transcript into
// chat:<sessionId>), and the composer types into that session's tmux pane
// (host.terminalChat.send). Chat and Terminal are then two views of one agent.
//
// FALLBACK — separate agent: if the session isn't mirrorable, we lazily create
// a standalone ChatBackend session (host.chat) and persist the mapping so a
// reload resumes it. (opencode mirroring is future work; it falls back today.)
import type { Host } from "@orden/host-api";
import { createChatStore, mountChatView, type ChatClient } from "@orden/chat-ui";
import { makeChatClient } from "./chatClient";
import type { Session } from "./sessions";

// chat-ui carries no markdown library. We inject a minimal SAFE renderer: a
// <div class="chat-md"> whose text is set via textContent (never innerHTML), with
// white-space: pre-wrap so newlines survive. Richer markdown (links, code blocks)
// is deferred to a later pass — swap this for a real renderer then.
function renderMarkdown(text: string): Node {
  const div = document.createElement("div");
  div.className = "chat-md";
  div.style.whiteSpace = "pre-wrap";
  div.textContent = text;
  return div;
}

// Build the mountChat fn bound to a host. Mirrors mountTerminal's shape:
// (container, session) => disposeFn.
export function createChatMount(
  host: Host,
  onVaultChange: (cb: (ns: string, key: string) => void) => void,
): (container: HTMLElement, session: Session) => () => void {
  const agentClient = makeChatClient(host);

  // A ChatClient for a mirrored terminal session: messages come from the
  // transcript (read via host.chat.getMessages, a pure vault read), and `send`
  // types into the terminal pane. Model/commands/permissions are owned by the
  // terminal itself, so they are inert here.
  const mirrorClient: ChatClient = {
    listSessions: async () => [],
    createSession: async () => {
      throw new Error("a mirrored terminal session is not creatable from chat");
    },
    getMessages: (id) => host.chat!.getMessages(id),
    send: (id, text) => host.terminalChat!.send(id, text),
    respondPermission: async () => {},
    setModel: async () => {},
    listModels: async () => [],
    listCommands: async () => [],
  };

  return (container, panelSession) => {
    let disposed = false;
    let disposeView: (() => void) | null = null;

    // The host change feed (onVaultChange) has no unsubscribe handle, so our
    // listener can't be removed. Instead keep a mutable `store` the listener
    // reads through: dispose() nulls it, neutralizing further deltas.
    let store: ReturnType<typeof createChatStore> | null = null;
    let ns: string | null = null;
    onVaultChange((changeNs, key) => {
      if (disposed || !store || changeNs !== ns) return;
      // The feed gives ns+key only (no value), so fetch the value; a deleted key
      // (null) clears that permission/message in the store.
      void host.vault.get(changeNs, key).then((v) => {
        if (!disposed && store) store.applyChange(changeNs, key, v ?? null);
      });
    });

    const placeholder = document.createElement("div");
    placeholder.className = "chat-starting";
    placeholder.textContent = "loading chat…";
    container.append(placeholder);

    void (async () => {
      try {
        // Prefer mirroring the terminal session; fall back to a separate agent.
        const mirrored = host.terminalChat
          ? await host.terminalChat.mirror(panelSession.id)
          : false;

        let chatSessionId: string;
        let client: ChatClient;
        if (mirrored) {
          chatSessionId = panelSession.id; // the transcript writes to chat:<panelId>
          client = mirrorClient;
        } else {
          client = agentClient;
          const link = await host.vault.get<string>("chat-link", panelSession.id);
          if (link) {
            chatSessionId = link;
          } else {
            const created = await client.createSession({
              harness: panelSession.agent,
              cwd: host.capabilities().filesRoot ?? ".",
              title: panelSession.title,
            });
            chatSessionId = created.id;
            await host.vault.set("chat-link", panelSession.id, chatSessionId);
          }
        }
        if (disposed) return;

        const s = createChatStore(chatSessionId);
        const initial = await client.getMessages(chatSessionId);
        if (disposed) return;
        s.hydrate(initial);
        ns = `chat:${chatSessionId}`;
        store = s; // arm the change-feed listener now that the store is ready

        placeholder.remove();
        const view = mountChatView({
          container,
          store: s,
          client,
          sessionId: chatSessionId,
          harness: panelSession.agent,
          renderMarkdown,
        });
        disposeView = view.dispose;
      } catch (err) {
        if (disposed) return;
        placeholder.className = "chat-error";
        placeholder.textContent =
          err instanceof Error ? `Chat unavailable: ${err.message}` : "Chat unavailable";
      }
    })();

    return () => {
      disposed = true;
      store = null; // neutralize the change-feed listener
      try {
        disposeView?.();
      } catch {
        /* ignore */
      }
      container.replaceChildren();
    };
  };
}
