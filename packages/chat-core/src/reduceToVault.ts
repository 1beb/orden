import type { ChatVault, DriverEvent, ChatSession, ChatMessage, ChatPart } from "./index";

// Width-4 zero-pad so `msg:NNNN` keys sort chronologically by lexical order.
// Caps clean lexical ordering at 9999 messages/session; past that, readers must
// sort numerically on the parsed suffix (the chatStore in Task 12 does so).
const PAD = 4;
const pad = (n: number) => String(n).padStart(PAD, "0");

// Applies one DriverEvent at a time to the vault for a single session.
// Holds per-session reduction state: the "current" open assistant message
// being assembled from streamed parts. The engine (Task 5) drives this.
export class VaultReducer {
  // The currently-open assistant message being assembled, plus its seq.
  // null between turns: the next text/tool starts a fresh message.
  private current: { seq: number; msg: ChatMessage } | null = null;
  // Monotonic counter for the next msg:<seq> allocation. Seeded lazily from
  // the vault on first use so resuming a populated session appends rather than
  // clobbering existing messages.
  private nextSeq: number | null = null;

  constructor(
    private vault: ChatVault,
    private sessionId: string,
  ) {}

  private get ns(): string {
    return `chat:${this.sessionId}`;
  }

  async apply(ev: DriverEvent): Promise<void> {
    switch (ev.kind) {
      case "session":
        await this.onSession(ev);
        return;
      case "text":
        await this.onText(ev);
        return;
      case "thinking":
        await this.onThinking(ev);
        return;
      case "tool":
        await this.onTool(ev);
        return;
      case "tool-result":
        await this.onToolResult(ev);
        return;
      case "turn-end":
        await this.onTurnEnd();
        return;
    }
  }

  private async onTurnEnd(): Promise<void> {
    if (!this.current) return;
    // A turn that ended with an unresolved tool is an error.
    let changed = false;
    for (const p of this.current.msg.parts) {
      if (p.type === "tool" && p.state === "running") {
        p.state = "error";
        changed = true;
      }
    }
    if (changed) await this.flush();
    // Close the message: the next text/tool starts a fresh msg:<seq>.
    this.current = null;
  }

  // Next seq to allocate, seeding from existing vault keys on first call so a
  // resumed session appends after stored messages.
  private async allocSeq(): Promise<number> {
    if (this.nextSeq === null) {
      const keys = await this.vault.list(this.ns);
      let max = -1;
      for (const k of keys) {
        if (!k.startsWith("msg:")) continue;
        const n = Number.parseInt(k.slice("msg:".length), 10);
        if (Number.isFinite(n) && n > max) max = n;
      }
      this.nextSeq = max + 1;
    }
    return this.nextSeq++;
  }

  // Ensure there is an open assistant message keyed by messageId, returning it.
  // A turn can carry MULTIPLE assistant messages, each with its own messageId
  // (text msg_A → tool msg_A → text msg_B → … → one turn-end). When the open
  // message's id differs from the incoming messageId, close it and open a fresh
  // msg:<seq> for the new id; matching ids reuse the open message.
  private async openMessage(messageId: string): Promise<ChatMessage> {
    if (this.current && this.current.msg.id !== messageId) {
      this.current = null;
    }
    if (!this.current) {
      const seq = await this.allocSeq();
      this.current = { seq, msg: { id: messageId, role: "assistant", parts: [] } };
    }
    return this.current.msg;
  }

  private async flush(): Promise<void> {
    if (!this.current) return;
    await this.vault.set(this.ns, `msg:${pad(this.current.seq)}`, this.current.msg);
  }

  private async onText(ev: { messageId: string; text: string }): Promise<void> {
    const msg = await this.openMessage(ev.messageId);
    const last = msg.parts[msg.parts.length - 1];
    if (last && last.type === "text") {
      last.text += ev.text;
    } else {
      const part: ChatPart = { type: "text", text: ev.text };
      msg.parts.push(part);
    }
    await this.flush();
  }

  private async onThinking(ev: { messageId: string; text: string }): Promise<void> {
    const msg = await this.openMessage(ev.messageId);
    const last = msg.parts[msg.parts.length - 1];
    if (last && last.type === "thinking") {
      last.text += ev.text;
    } else {
      const part: ChatPart = { type: "thinking", text: ev.text };
      msg.parts.push(part);
    }
    await this.flush();
  }

  private async onTool(ev: {
    messageId: string;
    toolId: string;
    name: string;
    input: unknown;
  }): Promise<void> {
    const msg = await this.openMessage(ev.messageId);
    const part: ChatPart = {
      type: "tool",
      toolId: ev.toolId,
      name: ev.name,
      input: ev.input,
      state: "running",
    };
    msg.parts.push(part);
    await this.flush();
  }

  private async onToolResult(ev: {
    toolId: string;
    output: string;
    ok: boolean;
  }): Promise<void> {
    // Out-of-order safety: no open message means nothing to attach to.
    if (!this.current) return;
    const part = this.current.msg.parts.find(
      (p): p is Extract<ChatPart, { type: "tool" }> =>
        p.type === "tool" && p.toolId === ev.toolId,
    );
    // No matching tool part: ignore rather than throw.
    if (!part) return;
    part.state = ev.ok ? "done" : "error";
    part.output = ev.output;
    await this.flush();
  }

  private async onSession(ev: { sessionId: string; slashCommands: string[] }): Promise<void> {
    const existing = await this.vault.get<ChatSession>(this.ns, "meta");
    // The engine (Task 5) writes full meta before any driver event, so `existing`
    // is the normal path. The placeholder below only guards a stray session event
    // with no prior meta; its harness is a throwaway the engine's meta overwrites.
    const base: ChatSession = existing ?? {
      id: ev.sessionId,
      title: "",
      harness: "claude",
      cwd: "",
      createdAt: 0,
    };
    const merged: ChatSession = { ...base, id: ev.sessionId, slashCommands: ev.slashCommands };
    await this.vault.set(this.ns, "meta", merged);
  }
}
