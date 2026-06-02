// Mirror a live terminal claude session's on-disk transcript into the chat
// vault, so the Chat tab shows the SAME conversation as the Terminal tab.
//
// claude has no API for a tmux session — it only persists to
// ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl — so we parse that file
// and re-parse it whenever it changes (claude appends to it as the turn runs).
// Parsed messages are written to vault ns `chat:<panelSessionId>` with the same
// `msg:<seq>` key shape the engine uses, so the existing chat store/view render
// them live via the change feed. We watch the PARENT directory (not the file)
// because the file may not exist until the session's first turn.
import { readFileSync } from "node:fs";
import { watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { ChatMessage, ChatVault } from "@orden/chat-core";
import { encodeCwd } from "../transcriptTitle";
import { parseClaudeTranscript } from "./claudeTranscript";

const pad = (n: number) => String(n).padStart(4, "0");

export class TranscriptMirror {
  private watcher: FSWatcher | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  // Last value written per key, so we only re-write (and re-notify the feed)
  // messages that actually changed rather than the whole transcript each tick.
  private written = new Map<string, string>();
  private count = 0;

  constructor(
    private readonly vault: ChatVault,
    private readonly sessionId: string,
    private readonly cwd: string,
    private readonly conversationId: string,
  ) {}

  private get file(): string {
    return join(homedir(), ".claude", "projects", encodeCwd(this.cwd), `${this.conversationId}.jsonl`);
  }

  private get ns(): string {
    return `chat:${this.sessionId}`;
  }

  start(): void {
    if (this.watcher) return; // idempotent
    void this.refresh();
    const dir = dirname(this.file);
    const target = basename(this.file);
    try {
      this.watcher = watch(dir, (_event, filename) => {
        if (filename === null || filename === target) this.schedule();
      });
    } catch {
      // The projects dir may not exist until claude's first write; a later
      // start() retry (on reopen) will pick it up. No throw.
    }
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.refresh(), 150);
  }

  private async refresh(): Promise<void> {
    let raw: string;
    try {
      raw = readFileSync(this.file, "utf8");
    } catch {
      return; // file not there yet
    }
    const messages = parseClaudeTranscript(raw);
    for (let i = 0; i < messages.length; i++) {
      const key = `msg:${pad(i)}`;
      const json = JSON.stringify(messages[i]);
      if (this.written.get(key) === json) continue; // unchanged — skip the write
      this.written.set(key, json);
      await this.vault.set<ChatMessage>(this.ns, key, messages[i]);
    }
    this.count = messages.length;
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.watcher?.close();
    this.watcher = null;
  }
}
