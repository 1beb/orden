import type { ChatVault, DriverEvent, ChatSession, ChatMessage, ChatPart } from "./index";

const PAD = 4;
const pad = (n: number) => String(n).padStart(PAD, "0");

// Applies one DriverEvent at a time to the vault for a single session.
// Holds per-session reduction state: the "current" open assistant message
// being assembled from streamed parts. The engine (Task 5) drives this.
export class VaultReducer {
  // The currently-open assistant message being assembled, plus its seq.
  // null between turns: the next text/tool starts a fresh message.
  private current: { seq: number; msg: ChatMessage } | null = null;
  // Monotonic counter for the next msg:<seq> allocation.
  private nextSeq = 0;

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
    }
  }

  // Ensure there is an open assistant message keyed by messageId, returning it.
  // If a message is already open it is reused (regardless of messageId — a turn
  // is a single assistant message in this model).
  private openMessage(messageId: string): ChatMessage {
    if (!this.current) {
      const seq = this.nextSeq++;
      this.current = { seq, msg: { id: messageId, role: "assistant", parts: [] } };
    }
    return this.current.msg;
  }

  private async flush(): Promise<void> {
    if (!this.current) return;
    await this.vault.set(this.ns, `msg:${pad(this.current.seq)}`, this.current.msg);
  }

  private async onText(ev: { messageId: string; text: string }): Promise<void> {
    const msg = this.openMessage(ev.messageId);
    const last = msg.parts[msg.parts.length - 1];
    if (last && last.type === "text") {
      last.text += ev.text;
    } else {
      const part: ChatPart = { type: "text", text: ev.text };
      msg.parts.push(part);
    }
    await this.flush();
  }

  private async onSession(ev: { sessionId: string; slashCommands: string[] }): Promise<void> {
    const existing = await this.vault.get<ChatSession & { slashCommands?: string[] }>(
      this.ns,
      "meta",
    );
    const base: ChatSession = existing ?? {
      id: ev.sessionId,
      title: "",
      harness: "claude",
      cwd: "",
      createdAt: 0,
    };
    const merged = { ...base, id: ev.sessionId, slashCommands: ev.slashCommands };
    await this.vault.set(this.ns, "meta", merged);
  }
}
