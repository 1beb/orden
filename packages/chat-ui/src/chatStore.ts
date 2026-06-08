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
  // Optimistic local echoes (the user's just-sent message) kept OUTSIDE the seq
  // keyspace so an in-flight mirror delta landing on the guessed next seq can't
  // clobber them — the bug that made a sent message vanish ("looks like it
  // didn't send"). `afterSeq` is the seq high-water mark at send time, so the
  // echo renders right after the history that existed when the user sent.
  let pending: { afterSeq: number; message: ChatMessage }[] = [];
  // Open permission requests keyed by permId; insertion order is request order.
  const perms = new Map<string, PermissionRequest>();

  const textOf = (m: ChatMessage): string =>
    m.parts.map((p) => (p.type === "text" ? p.text : "")).join("");

  function rebuildMessages() {
    const seqEntries = [...bySeq.entries()].sort((a, b) => a[0] - b[0]);
    // Reconcile: once the source records a user turn with the same text (claude's
    // transcript does; opencode never does — it drops user parts), drop the
    // optimistic echo so it isn't shown twice. opencode echoes thus persist.
    const confirmed = new Set(
      seqEntries.filter(([, m]) => m.role === "user").map(([, m]) => textOf(m)),
    );
    pending = pending.filter((p) => !confirmed.has(textOf(p.message)));
    // Merge: emit each pending echo before the first seq strictly greater than
    // its afterSeq, so an idle-send echo precedes the reply it triggered and a
    // mid-turn echo follows the history that existed when it was sent.
    const out: ChatMessage[] = [];
    let pi = 0;
    for (const [seq, m] of seqEntries) {
      while (pi < pending.length && pending[pi].afterSeq < seq) out.push(pending[pi++].message);
      out.push(m);
    }
    while (pi < pending.length) out.push(pending[pi++].message);
    msgs = out;
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
      pending.push({ afterSeq: maxSeq, message });
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
