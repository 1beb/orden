// Host-side TerminalChat: mirror a live terminal session's transcript into the
// chat vault and type into its agent pane. For claude this reads the on-disk
// JSONL (see TranscriptMirror); for opencode it subscribes to the live SSE
// event stream (see OpencodeMirror). `send` is harness-agnostic — it types into
// the tmux pane, exactly like plan-annotation delivery does.
import type { Host, Session, TerminalChat } from "@orden/host-api";
import { TranscriptMirror } from "./transcriptMirror";
import { OpencodeMirror } from "./opencodeMirror";
import { resolveSessionCwd } from "../terminal";
import { defaultPaneOps } from "../annotationDelivery";
import { defaultConnect } from "./adapters/opencode";

type AnyMirror = TranscriptMirror | OpencodeMirror;

export class NodeTerminalChat implements TerminalChat {
  private readonly mirrors = new Map<string, AnyMirror>();

  constructor(
    private readonly host: Host,
    private readonly defaultCwd: string,
  ) {}

  async mirror(sessionId: string): Promise<boolean> {
    if (this.mirrors.has(sessionId)) return true;
    const sess = await this.host.vault.get<Session>("sessions", sessionId);
    if (!sess || !sess.conversationId) return false;
    const cwd = await resolveSessionCwd(this.host, sess.projectId, this.defaultCwd);

    if (sess.agent === "claude") {
      const mirror = new TranscriptMirror(this.host.vault, sessionId, cwd, sess.conversationId);
      this.mirrors.set(sessionId, mirror);
      mirror.start();
      return true;
    }

    if (sess.agent === "opencode") {
      const mirror = new OpencodeMirror(
        this.host.vault,
        sessionId,
        cwd,
        sess.conversationId,
        defaultConnect,
      );
      this.mirrors.set(sessionId, mirror);
      mirror.start();
      return true;
    }

    return false;
  }

  async send(sessionId: string, text: string): Promise<void> {
    await defaultPaneOps(this.host, this.defaultCwd).sendText(sessionId, text);
  }
}
