// Host-side TerminalChat: mirror a live terminal session's transcript into the
// chat vault and type into its agent pane. For claude this reads the on-disk
// JSONL (see TranscriptMirror); for opencode it subscribes to the live SSE
// event stream (see OpencodeMirror). `send` is harness-agnostic — it types into
// the tmux pane, exactly like plan-annotation delivery does. `answerQuestion`
// drives claude's interactive AskUserQuestion menu by sending the keystrokes the
// chat UI's answer implies (see questionKeystrokes).
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Host, QuestionResponse, Session, TerminalChat } from "@orden/host-api";
import { TranscriptMirror } from "./transcriptMirror";
import { OpencodeMirror } from "./opencodeMirror";
import { parseClaudeTranscript } from "./claudeTranscript";
import { encodeCwd } from "../transcriptTitle";
import { resolveSessionCwd } from "../terminal";
import { defaultPaneOps, type PaneOps } from "../annotationDelivery";
import { defaultConnect } from "./adapters/opencode";
import { encodeQuestionKeystrokes, type QuestionSpec } from "./questionKeystrokes";

type AnyMirror = TranscriptMirror | OpencodeMirror;

interface RawQuestion {
  options?: unknown[];
  multiSelect?: boolean;
}

// Reduce an AskUserQuestion tool_use (found by id in a parsed transcript) to the
// per-question specs the keystroke encoder needs. Pure — the file IO that feeds
// it `raw` lives on NodeTerminalChat so this stays unit-testable. Returns null if
// the tool id isn't an AskUserQuestion (or carries no questions) in the transcript.
export function questionSpecsFromTranscript(
  raw: string,
  toolId: string,
): QuestionSpec[] | null {
  for (const msg of parseClaudeTranscript(raw)) {
    for (const part of msg.parts) {
      if (part.type !== "tool" || part.toolId !== toolId) continue;
      if (part.name !== "AskUserQuestion") return null;
      const questions = (part.input as { questions?: RawQuestion[] })?.questions;
      if (!Array.isArray(questions)) return null;
      return questions.map((q) => ({
        optionCount: Array.isArray(q.options) ? q.options.length : 0,
        multiSelect: q.multiSelect === true,
      }));
    }
  }
  return null;
}

// How NodeTerminalChat loads a session's transcript text. Injectable so the
// answer path is testable without touching the real ~/.claude transcript files.
export type TranscriptReader = (cwd: string, conversationId: string) => string | null;

const fsTranscriptReader: TranscriptReader = (cwd, conversationId) => {
  const file = join(homedir(), ".claude", "projects", encodeCwd(cwd), `${conversationId}.jsonl`);
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null; // not written yet / unreadable
  }
};

export interface NodeTerminalChatDeps {
  // Injectable so the keystroke path is testable without driving real tmux.
  paneOps?: PaneOps;
  // Injectable so spec derivation is testable without real transcript files.
  readTranscript?: TranscriptReader;
}

export class NodeTerminalChat implements TerminalChat {
  private readonly mirrors = new Map<string, AnyMirror>();
  private readonly paneOps: PaneOps;
  private readonly readTranscript: TranscriptReader;

  constructor(
    private readonly host: Host,
    private readonly defaultCwd: string,
    deps: NodeTerminalChatDeps = {},
  ) {
    this.paneOps = deps.paneOps ?? defaultPaneOps(host, defaultCwd);
    this.readTranscript = deps.readTranscript ?? fsTranscriptReader;
  }

  async mirror(sessionId: string): Promise<boolean> {
    if (this.mirrors.has(sessionId)) return true;
    const sess = await this.host.vault.get<Session>("sessions", sessionId);
    if (!sess || !sess.conversationId) return false;
    const cwd = await resolveSessionCwd(this.host, sess, sessionId, this.defaultCwd);

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

  // Start mirroring every LIVE mirrorable session at boot, so a pending
  // AskUserQuestion — or any in-flight turn — surfaces in the Chat tab without the
  // user first opening that session. We mirror only sessions with a live agent
  // pane: a dead session's transcript never changes again, so a mirror for it is
  // pure waste — it still reads + fully re-parses the whole JSONL and writes up to
  // WINDOW vault entries. At scale (100+ historical sessions) that boot fan-out of
  // re-parses + vault writes saturates the CPU (one core pegged, multi-GB RSS).
  // Dead sessions mirror lazily when opened (chatMount), which is the only time
  // their tail actually needs to render. Best-effort per session.
  async mirrorAll(): Promise<void> {
    let ids: string[];
    try {
      ids = await this.host.vault.list("sessions");
    } catch {
      return;
    }
    for (const id of ids) {
      try {
        if (!(await this.paneOps.isLive(id))) continue;
        await this.mirror(id);
      } catch {
        // One unmirrorable (or unprobeable) session shouldn't stop the rest.
      }
    }
  }

  async send(sessionId: string, text: string): Promise<void> {
    await this.paneOps.sendText(sessionId, text);
  }

  async answerQuestion(
    sessionId: string,
    toolId: string,
    response: QuestionResponse,
  ): Promise<void> {
    // The question structure (option counts, multiSelect flags) comes from the
    // transcript — the authoritative record — not from the client, so a stale
    // chat view can't desync the keystroke math.
    const specs = await this.readQuestionSpecs(sessionId, toolId);
    if (!specs) throw new Error(`answerQuestion: no AskUserQuestion ${toolId} in transcript`);
    const ops = encodeQuestionKeystrokes(specs, response);
    await this.paneOps.sendKeys(sessionId, ops);
  }

  // Locate the AskUserQuestion tool_use by id in the session's transcript and
  // reduce its questions to the specs the encoder needs. Returns null if the
  // session/transcript/tool can't be found.
  private async readQuestionSpecs(
    sessionId: string,
    toolId: string,
  ): Promise<QuestionSpec[] | null> {
    const sess = await this.host.vault.get<Session>("sessions", sessionId);
    if (!sess || sess.agent !== "claude" || !sess.conversationId) return null;
    const cwd = await resolveSessionCwd(this.host, sess, sessionId, this.defaultCwd);
    const raw = this.readTranscript(cwd, sess.conversationId);
    if (raw == null) return null;
    return questionSpecsFromTranscript(raw, toolId);
  }
}
