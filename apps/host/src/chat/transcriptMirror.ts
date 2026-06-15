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
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { ChatMessage, ChatVault } from "@orden/chat-core";
import { encodeCwd } from "../transcriptTitle";
import {
  newTranscriptParseState,
  parseTranscriptInto,
  type TranscriptParseState,
} from "./claudeTranscript";

const pad = (n: number) => String(n).padStart(4, "0");

// Only the most recent WINDOW messages are written to the vault on load. Parsing
// the whole JSONL is cheap; writing every message (and firing the change feed +
// a web fetch for each) is what made first load slow on a long transcript. The
// user looks at the tail, so we write the tail; older history (scroll-up
// pagination) is a follow-up. Appended turns extend past the window naturally.
const WINDOW = 200;

export class TranscriptMirror {
  private watcher: FSWatcher | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  // Last value written per key, so we only re-write (and re-notify the feed)
  // messages that actually changed rather than the whole transcript each tick.
  private written = new Map<string, string>();
  private count = 0;
  // Prune orphaned vault keys once per process. See flush().
  private pruned = false;
  // Incremental parse state: claude only APPENDS to the JSONL, so each tick we
  // read just the bytes past `offset` and feed them to `parseState` rather than
  // re-reading + re-parsing the whole file (a long live turn fires the watcher
  // every ~150ms; full re-parse pegged a core). `pending` carries a partial
  // trailing line — one written mid-append — until its newline arrives.
  private parseState: TranscriptParseState = newTranscriptParseState();
  private offset = 0;
  private pending: Buffer = Buffer.alloc(0);

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
    let fd: number;
    try {
      fd = openSync(this.file, "r");
    } catch {
      return; // file not there yet
    }
    try {
      const size = fstatSync(fd).size;
      if (size < this.offset) {
        // The file shrank — a rotated/rewritten transcript reusing this path.
        // Our absolute-seq state is no longer valid; restart from the top.
        this.resetParse();
      }
      if (size === this.offset && this.pending.length === 0) {
        return; // no new bytes (spurious watch tick) — nothing to parse or write
      }
      if (size > this.offset) {
        const buf = Buffer.allocUnsafe(size - this.offset);
        const n = readSync(fd, buf, 0, buf.length, this.offset);
        this.offset += n;
        this.pending = this.pending.length ? Buffer.concat([this.pending, buf.subarray(0, n)]) : buf.subarray(0, n);
      }
    } finally {
      closeSync(fd);
    }
    // Parse only up to the last newline; the remainder is a line claude is still
    // writing, withheld until its newline lands. A newline byte never appears
    // inside a UTF-8 multibyte sequence, so slicing on it is character-safe.
    const lastNl = this.pending.lastIndexOf(0x0a);
    if (lastNl < 0) return; // no complete line yet
    const completeText = this.pending.subarray(0, lastNl + 1).toString("utf8");
    this.pending = this.pending.subarray(lastNl + 1);
    parseTranscriptInto(this.parseState, completeText);
    await this.flush();
  }

  private resetParse(): void {
    this.parseState = newTranscriptParseState();
    this.offset = 0;
    this.pending = Buffer.alloc(0);
    this.written.clear();
    this.pruned = false;
  }

  // Write the WINDOW tail of the accumulated messages, skipping unchanged keys.
  private async flush(): Promise<void> {
    const messages = this.parseState.messages;
    // Absolute seq (index in the full transcript) so appended turns get stable,
    // ever-increasing keys; only write the last WINDOW so first load is bounded.
    const start = Math.max(0, messages.length - WINDOW);
    for (let i = start; i < messages.length; i++) {
      const key = `msg:${pad(i)}`;
      const json = JSON.stringify(messages[i]);
      if (this.written.get(key) === json) continue; // unchanged — skip the write
      this.written.set(key, json);
      await this.vault.set<ChatMessage>(this.ns, key, messages[i]);
    }
    // Drop vault bubbles orphaned past the current end. We write keys by absolute
    // seq and never overwrite a key that no longer exists, so a prior process (or
    // an older parser that didn't strip skill bodies / isMeta entries) can leave
    // msg:<seq> keys beyond the new, shorter parse — e.g. a loaded skill's
    // markdown left rendering as a user turn after the parser learned to drop it.
    // Only keys at/after the current length are stale; earlier ones are real
    // scroll-up history. Once per process suffices: within a process the
    // transcript only grows, so no new orphans appear.
    if (!this.pruned) {
      this.pruned = true;
      for (const key of await this.vault.list(this.ns)) {
        const m = /^msg:(\d+)$/.exec(key);
        if (m && Number(m[1]) >= messages.length) {
          this.written.delete(key);
          await this.vault.delete(this.ns, key);
        }
      }
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
