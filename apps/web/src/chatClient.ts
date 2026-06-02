// Adapt the host's ChatBackend (host.chat) to chat-ui's ChatClient. The two
// interfaces share method shapes (ChatClient depends only on @orden/chat-core,
// ChatBackend lives on the host), so this is a thin delegating wrapper.
//
// host.chat is optional: on a host without a chat backend the wrapper's methods
// throw a clear error, so the Chat tab is effectively disabled there.
import type { ChatClient } from "@orden/chat-ui";
import type { Host } from "@orden/host-api";

export function makeChatClient(host: Host): ChatClient {
  function backend() {
    const chat = host.chat;
    if (!chat) throw new Error("chat backend unavailable");
    return chat;
  }
  return {
    listSessions: () => backend().listSessions(),
    createSession: (opts) => backend().createSession(opts),
    getMessages: (id) => backend().getMessages(id),
    send: (id, text, opts) => backend().send(id, text, opts),
    respondPermission: (id, reqId, d) => backend().respondPermission(id, reqId, d),
    setModel: (id, model) => backend().setModel(id, model),
    listModels: (harness) => backend().listModels(harness),
    listCommands: (id) => backend().listCommands(id),
  };
}
