import type { ChatMessage, PermissionRequest } from "@orden/chat-core";

export interface ChatStore {
  hydrate(messages: ChatMessage[]): void;
  applyChange(ns: string, key: string, value: unknown): void;
  messages(): ChatMessage[];
  pendingPermissions(): PermissionRequest[];
  onChange(cb: () => void): () => void;
}

export function createChatStore(sessionId: string): ChatStore {
  const subscribers = new Set<() => void>();
  const ns = `chat:${sessionId}`;
  let msgs: ChatMessage[] = [];
  // Messages keyed by numeric seq so each msg:<seq> change upserts in place.
  const bySeq = new Map<number, ChatMessage>();
  // Open permission requests keyed by permId; insertion order is request order.
  const perms = new Map<string, PermissionRequest>();

  function rebuildMessages() {
    msgs = [...bySeq.entries()].sort((a, b) => a[0] - b[0]).map(([, m]) => m);
  }

  function notify() {
    for (const cb of subscribers) cb();
  }

  return {
    hydrate(messages) {
      msgs = [...messages];
    },
    applyChange(changeNs, key, value) {
      if (changeNs !== ns) return; // defensive: ignore other sessions' deltas
      if (key.startsWith("msg:")) {
        const seq = Number.parseInt(key.slice("msg:".length), 10);
        if (Number.isNaN(seq)) return;
        bySeq.set(seq, value as ChatMessage);
        rebuildMessages();
        notify();
      } else if (key.startsWith("perm:")) {
        const permId = key.slice("perm:".length);
        if (value == null) perms.delete(permId);
        else perms.set(permId, value as PermissionRequest);
        notify();
      }
      // The `meta` key (a ChatSession) is accepted but not surfaced here; it is
      // not a message and needs no store state for the view.
    },
    messages() {
      return msgs;
    },
    pendingPermissions() {
      return [...perms.values()];
    },
    onChange(cb) {
      subscribers.add(cb);
      return () => subscribers.delete(cb);
    },
  };
}
