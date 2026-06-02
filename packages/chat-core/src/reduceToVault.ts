import type { ChatVault, DriverEvent, ChatSession } from "./index";

const PAD = 4;
const pad = (n: number) => String(n).padStart(PAD, "0");

// Applies one DriverEvent at a time to the vault for a single session.
// Holds per-session reduction state: the "current" open assistant message
// being assembled from streamed parts. The engine (Task 5) drives this.
export class VaultReducer {
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
    }
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
