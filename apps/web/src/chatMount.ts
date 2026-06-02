// Mount the native Chat tab (the @orden/chat-ui view) for a panel session.
//
// v1 ARCHITECTURE NOTE: the Terminal tab and the Chat tab are INDEPENDENT agent
// processes. The Terminal drives a tmux SessionManager session (host.sessions,
// keyed by the panel session id); the Chat tab drives a SEPARATE ChatBackend
// session (host.chat). For now we lazily create ONE ChatBackend session per panel
// session and persist the mapping so a reload resumes it. Unifying the two so a
// session has a single underlying agent is future work.
import type { Host } from "@orden/host-api";
import { createChatStore, mountChatView } from "@orden/chat-ui";
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
  const client = makeChatClient(host);

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

    // Placeholder while the (async) ChatBackend session resolves.
    const placeholder = document.createElement("div");
    placeholder.className = "chat-starting";
    placeholder.textContent = "starting chat…";
    container.append(placeholder);

    void (async () => {
      try {
        // Resolve-or-create the ChatBackend session for this panel session.
        const link = await host.vault.get<string>("chat-link", panelSession.id);
        let chatSessionId: string;
        if (link) {
          chatSessionId = link;
        } else {
          const created = await client.createSession({
            harness: panelSession.agent,
            // capabilities() carries no files root; "." lets the host resolve cwd
            // against its own defaultCwd (files root / process cwd).
            cwd: ".",
            title: panelSession.title,
          });
          chatSessionId = created.id;
          await host.vault.set("chat-link", panelSession.id, chatSessionId);
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
      // Don't kill the ChatBackend session — reopening resumes it.
      container.replaceChildren();
    };
  };
}
