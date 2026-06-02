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
  let msgs: ChatMessage[] = [];

  return {
    hydrate(messages) {
      msgs = [...messages];
    },
    applyChange(_ns, _key, _value) {},
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
