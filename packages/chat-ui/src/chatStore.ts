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

  function rebuildMessages() {
    msgs = [...bySeq.entries()].sort((a, b) => a[0] - b[0]).map(([, m]) => m);
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
      }
    },
    messages() {
      return msgs;
    },
    pendingPermissions() {
      return [];
    },
    onChange(cb) {
      subscribers.add(cb);
      return () => subscribers.delete(cb);
    },
  };
}
