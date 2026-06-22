// Mirror a live opencode terminal session's events into the chat vault, so the
// Chat tab shows the SAME conversation as the Terminal tab.
//
// Unlike claude (which writes JSONL files), opencode streams events over its
// SSE API. We connect to opencode, subscribe to events, filter by the
// terminal session's id, translate to DriverEvents, and feed them to a
// VaultReducer — the same reducer the chat engine uses. Writes go to vault ns
// `chat:<panelSessionId>` so the existing chat store/view render them live.
import type { Event } from "@opencode-ai/sdk";
import type { ChatVault } from "@orden/chat-core";
import { VaultReducer } from "@orden/chat-core";
import type { ConnectFn, OpencodeConnection } from "./adapters/opencode";
import { OpencodeTranslator } from "./opencodeEventToEvents";
import { eventBelongsTo } from "./adapters/opencode";

export class OpencodeMirror {
  private conn: OpencodeConnection | null = null;
  private closed = false;
  private running: Promise<void> | null = null;

  constructor(
    private readonly vault: ChatVault,
    private readonly sessionId: string, // panel session id (vault ns = chat:<sessionId>)
    private readonly cwd: string,
    private readonly opencodeSessionId: string, // opencode's own session id
    private readonly connect: ConnectFn,
  ) {}

  start(): void {
    if (this.closed) return;

    const reducer = new VaultReducer(this.vault, this.sessionId);
    // Emit the session event so the reducer stores the underlying session id as
    // meta (slashCommands are empty because the TUI has no chat-side commands).
    void reducer.apply({ kind: "session", sessionId: this.opencodeSessionId, slashCommands: [] });

    const translator = new OpencodeTranslator(this.opencodeSessionId);

    this.running = (async () => {
      let conn: OpencodeConnection | null = null;
      try {
        conn = await this.connect();
        this.conn = conn;
        if (this.closed) {
          conn.close();
          return;
        }

        const sub = await conn.client.event.subscribe();
        for await (const event of sub.stream as AsyncIterable<Event>) {
          if (this.closed) break;
          if (!eventBelongsTo(event, this.opencodeSessionId)) continue;
          if (event.type === "permission.updated") continue; // TUI handles perms; mirror ignores
          for (const ev of translator.translate(event)) {
            await reducer.apply(ev);
          }
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`opencode mirror: stream error for session ${this.sessionId}:`, err);
      } finally {
        this.conn = null;
        conn?.close();
      }
    })();
  }

  stop(): void {
    this.closed = true;
    this.conn?.close();
    this.conn = null;
  }
}
