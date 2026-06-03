// Mount the native Chat tab (the @orden/chat-ui view) for a panel session.
//
// PREFERRED PATH — terminal mirror: if the session can be mirrored (claude via
// TranscriptMirror, opencode via OpencodeMirror), the Chat tab shows the SAME
// conversation the Terminal tab runs, and the composer types into that session's
// tmux pane. Chat and Terminal are then two views of one agent.
//
// FALLBACK — separate agent: if the session isn't mirrorable, we lazily create
// a standalone ChatBackend session (host.chat) and persist the mapping so a
// reload resumes it.
import type { Host } from "@orden/host-api";
import { createChatStore, mountChatView, type ChatClient } from "@orden/chat-ui";
import { makeChatClient } from "./chatClient";
import { renderMarkdown } from "./chatMarkdown";
import type { Session } from "./sessions";

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
    answerQuestion: (id, toolId, response) =>
      host.terminalChat!.answerQuestion(id, toolId, response),
    respondPermission: async () => {},
    // The terminal owns its model; setModel is display-only here for now.
    setModel: async () => {},
    listModels: (harness) => host.chat!.listModels(harness),
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
        let mirrored = host.terminalChat
          ? await host.terminalChat.mirror(panelSession.id)
          : false;

        // A freshly-created session mints its conversationId host-side at
        // launch — a beat AFTER the panel synchronously opens this Chat tab, so
        // the first mirror() attempt loses the race and returns false. Falling
        // back here would strand the tab on a SEPARATE, empty agent, and the
        // starter prompt (which went to the terminal session) would never show.
        // We therefore WAIT for the mirror to attach before falling back.
        if (!mirrored && host.terminalChat) {
          for (let i = 0; i < 60 && !mirrored; i++) {
            await new Promise((r) => setTimeout(r, 400));
            if (disposed) return;
            mirrored = await host.terminalChat.mirror(panelSession.id);
          }
        }

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
