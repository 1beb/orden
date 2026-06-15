// TranscriptMirror prune behavior: when the parser yields FEWER messages than a
// prior run wrote (e.g. the parser learned to drop loaded-skill bodies), the
// orphaned msg:<seq> vault keys past the new end must be deleted — otherwise a
// skill's markdown keeps rendering as a user turn in the mirrored chat.
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, ChatVault } from "@orden/chat-core";

// TranscriptMirror resolves the transcript path from os.homedir(). Under vitest
// workers, os.homedir() does not reflect a runtime process.env.HOME reassignment,
// so mock node:os to read it live — letting the test point the mirror at a temp
// home. Everything else (tmpdir, etc.) keeps the real implementation.
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => process.env.HOME ?? actual.homedir() };
});
import { encodeCwd } from "../../src/transcriptTitle";
import { TranscriptMirror } from "../../src/chat/transcriptMirror";

class MemVault implements ChatVault {
  store = new Map<string, Map<string, unknown>>();
  private ns(n: string) {
    let m = this.store.get(n);
    if (!m) this.store.set(n, (m = new Map()));
    return m;
  }
  async get<T>(ns: string, key: string): Promise<T | null> {
    return (this.ns(ns).get(key) as T) ?? null;
  }
  async set<T>(ns: string, key: string, value: T): Promise<void> {
    this.ns(ns).set(key, value);
  }
  async list(ns: string): Promise<string[]> {
    return [...this.ns(ns).keys()];
  }
  async delete(ns: string, key: string): Promise<void> {
    this.ns(ns).delete(key);
  }
}

const CWD = "/home/b/projects/orden";
const CONV = "conv-test";
const SESSION = "sess_test_1";

// Two real human turns; everything else (skill load + meta body) the parser drops.
const TRANSCRIPT = [
  { type: "user", message: { role: "user", content: "first prompt" } },
  {
    type: "assistant",
    message: { id: "a1", role: "assistant", content: [{ type: "text", text: "reply" }] },
  },
  { type: "user", message: { role: "user", content: "second prompt" } },
]
  .map((e) => JSON.stringify(e))
  // Trailing newline: real claude transcripts terminate every entry with "\n";
  // the mirror treats a non-terminated final line as a mid-append partial and
  // withholds it until its newline lands.
  .map((line) => `${line}\n`)
  .join("");

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "mirror-test-"));
  process.env.HOME = home;
  const dir = join(home, ".claude", "projects", encodeCwd(CWD));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${CONV}.jsonl`), TRANSCRIPT);
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("TranscriptMirror prune", () => {
  it("deletes orphaned msg keys past the new, shorter parse", async () => {
    const vault = new MemVault();
    const ns = `chat:${SESSION}`;
    // Simulate an OLD run (parser kept a skill body) that wrote 5 messages: the
    // 3 real ones plus 2 extras at the tail.
    for (let i = 0; i < 5; i++) {
      await vault.set<ChatMessage>(ns, `msg:000${i}`, {
        id: `old${i}`,
        role: "user",
        parts: [{ type: "text", text: i === 3 ? "Base directory for this skill: ..." : `old ${i}` }],
      });
    }

    const mirror = new TranscriptMirror(vault, SESSION, CWD, CONV);
    await (mirror as unknown as { refresh(): Promise<void> }).refresh();

    const keys = (await vault.list(ns)).sort();
    // New parse yields 3 messages (msg:0000..0002); the orphaned tail (0003, 0004)
    // — including the leaked skill body — must be gone.
    expect(keys).toEqual(["msg:0000", "msg:0001", "msg:0002"]);
    const last = await vault.get<ChatMessage>(ns, "msg:0002");
    expect(last?.parts[0]).toMatchObject({ type: "text", text: "second prompt" });
  });
});

describe("TranscriptMirror incremental refresh", () => {
  const file = () => join(home, ".claude", "projects", encodeCwd(CWD), `${CONV}.jsonl`);
  const line = (e: unknown) => `${JSON.stringify(e)}\n`;
  const refresh = (m: TranscriptMirror) =>
    (m as unknown as { refresh(): Promise<void> }).refresh();

  // A counting vault so we can assert ticks with no new bytes do NO writes.
  class CountingVault extends MemVault {
    sets = 0;
    override async set<T>(ns: string, key: string, value: T): Promise<void> {
      this.sets++;
      await super.set(ns, key, value);
    }
  }

  it("parses only appended bytes and flips an earlier tool via a later append", async () => {
    writeFileSync(file(), line({ type: "user", message: { role: "user", content: "run it" } }));
    const vault = new MemVault();
    const ns = `chat:${SESSION}`;
    const mirror = new TranscriptMirror(vault, SESSION, CWD, CONV);

    await refresh(mirror);
    expect((await vault.list(ns)).sort()).toEqual(["msg:0000"]);

    // Append an assistant tool_use, then (a separate append) its tool_result —
    // the result must flip the tool parsed in the earlier chunk.
    appendFileSync(
      file(),
      line({
        type: "assistant",
        message: {
          id: "a1",
          role: "assistant",
          content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }],
        },
      }),
    );
    await refresh(mirror);
    expect((await vault.get<ChatMessage>(ns, "msg:0001"))?.parts[0]).toMatchObject({
      type: "tool",
      toolId: "t1",
      state: "running",
    });

    appendFileSync(
      file(),
      line({
        type: "user",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "a.ts" }] },
      }),
    );
    await refresh(mirror);
    expect((await vault.get<ChatMessage>(ns, "msg:0001"))?.parts[0]).toMatchObject({
      type: "tool",
      toolId: "t1",
      state: "done",
      output: "a.ts",
    });
  });

  it("withholds a non-terminated partial line until its newline arrives", async () => {
    writeFileSync(file(), line({ type: "user", message: { role: "user", content: "first" } }));
    const vault = new MemVault();
    const ns = `chat:${SESSION}`;
    const mirror = new TranscriptMirror(vault, SESSION, CWD, CONV);
    await refresh(mirror);

    // claude has written the next entry but not yet its terminating newline.
    const partial = JSON.stringify({ type: "user", message: { role: "user", content: "second" } });
    appendFileSync(file(), partial);
    await refresh(mirror);
    expect((await vault.list(ns)).sort()).toEqual(["msg:0000"]); // partial NOT parsed

    appendFileSync(file(), "\n");
    await refresh(mirror);
    expect((await vault.list(ns)).sort()).toEqual(["msg:0000", "msg:0001"]);
    expect((await vault.get<ChatMessage>(ns, "msg:0001"))?.parts[0]).toMatchObject({ text: "second" });
  });

  it("does no work on a tick with no new bytes", async () => {
    writeFileSync(file(), line({ type: "user", message: { role: "user", content: "only" } }));
    const vault = new CountingVault();
    const mirror = new TranscriptMirror(vault, SESSION, CWD, CONV);

    await refresh(mirror);
    const afterFirst = vault.sets;
    expect(afterFirst).toBe(1);

    await refresh(mirror); // spurious watch tick, file unchanged
    expect(vault.sets).toBe(afterFirst); // no re-write
  });
});
