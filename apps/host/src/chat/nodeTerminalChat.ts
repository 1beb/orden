// Host-side TerminalChat: mirror a live terminal session's transcript into the
// chat vault and type into its agent pane. For claude this reads the on-disk
// JSONL (see TranscriptMirror); opencode is a future second source (it has a
// queryable API + store). `send` is harness-agnostic — it types into the tmux
// pane, exactly like plan-annotation delivery does.
import type { Host, Session, TerminalChat } from "@orden/host-api";
import { TranscriptMirror } from "./transcriptMirror";
import { resolveSessionCwd } from "../terminal";
import { defaultPaneOps } from "../annotationDelivery";

export class NodeTerminalChat implements TerminalChat {
  private readonly mirrors = new Map<string, TranscriptMirror>();

  constructor(
    private readonly host: Host,
    private readonly defaultCwd: string,
  ) {}

  async mirror(sessionId: string): Promise<boolean> {
    if (this.mirrors.has(sessionId)) return true;
    const sess = await this.host.vault.get<Session>("sessions", sessionId);
    // Only claude is mirrorable today, and only once it has a conversation id
    // (the transcript file is named after it). opencode mirror is future work.
    if (!sess || sess.agent !== "claude" || !sess.conversationId) return false;
    const cwd = await resolveSessionCwd(this.host, sess.projectId, this.defaultCwd);
    const mirror = new TranscriptMirror(this.host.vault, sessionId, cwd, sess.conversationId);
    this.mirrors.set(sessionId, mirror);
    mirror.start();
    return true;
  }

  async send(sessionId: string, text: string): Promise<void> {
    await defaultPaneOps(this.host, this.defaultCwd).sendText(sessionId, text);
  }
}
