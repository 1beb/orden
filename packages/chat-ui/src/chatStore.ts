import type { ChatMessage, KeyedMessage, PermissionRequest } from "@orden/chat-core";

export interface ChatStore {
  hydrate(messages: ChatMessage[]): void;
  hydrateKeyed(entries: KeyedMessage[]): void;
  applyChange(ns: string, key: string, value: unknown): void;
  addMessage(message: ChatMessage): void;
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
      // Seed bySeq too, not just msgs: the engine allocates msg:<seq> keys
      // contiguously from 0, and getMessages returns them in that order, so the
      // array index equals the seq. Without this, the first live msg:<seq> delta
      // would rebuild msgs purely from an empty bySeq and drop all history.
      bySeq.clear();
      messages.forEach((m, i) => bySeq.set(i, m));
      rebuildMessages();
    },
    hydrateKeyed(entries) {
      // Seed bySeq at each message's REAL seq, not its array position. The
      // terminal mirror keys by absolute transcript index and only writes a
      // sliding window, so on-disk keys can start at an offset and have gaps —
      // array-index hydration would then place history at seqs that disagree
      // with the live msg:<seq> deltas, reordering/duplicating messages. Sharing
      // one keyspace makes a delta upsert exactly where its message was seeded.
      bySeq.clear();
      for (const { seq, message } of entries) bySeq.set(seq, message);
      rebuildMessages();
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
    addMessage(message) {
      let maxSeq = -1;
      for (const seq of bySeq.keys()) {
        if (seq > maxSeq) maxSeq = seq;
      }
      bySeq.set(maxSeq + 1, message);
      rebuildMessages();
      notify();
    },
    messages() {
      return [...msgs]; // copy: callers must not mutate store state (matches pendingPermissions)
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
