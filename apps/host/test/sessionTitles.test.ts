import { describe, it, expect, vi, beforeEach } from "vitest";

// The transcript readers are mocked so the test never touches the real
// ~/.claude transcript dir — we drive title/prompt outcomes directly.

const readTranscriptTitle = vi.fn((_cwd: string, _id: string): string | null => null);
const readUserPrompt = vi.fn((_cwd: string, _id: string): string | null => null);
const readTranscriptSummary = vi.fn((_cwd: string, _id: string): string | null => null);
vi.mock("../src/transcriptTitle", () => ({
  encodeCwd: (s: string) => s,
  readTranscriptTitle: (cwd: string, id: string) => readTranscriptTitle(cwd, id),
  readUserPrompt: (cwd: string, id: string) => readUserPrompt(cwd, id),
  readTranscriptSummary: (cwd: string, id: string) => readTranscriptSummary(cwd, id),
  firstUserPrompt: () => null,
}));

import { reconcileUntitledSessions } from "../src/sessionTitles";
import type { Host } from "@orden/host-api";

type Store = Record<string, Record<string, Record<string, unknown>>>;

function makeHost(records: Store): { host: Host; store: Store } {
  const store = JSON.parse(JSON.stringify(records)) as Store;
  const host = {
    vault: {
      async get<T>(ns: string, key: string): Promise<T | null> {
        return (store[ns]?.[key] as T) ?? null;
      },
      async set<T>(ns: string, key: string, value: T): Promise<void> {
        (store[ns] ??= {})[key] = value as Record<string, unknown>;
      },
      async list(ns: string): Promise<string[]> {
        return Object.keys(store[ns] ?? {});
      },
      async delete(ns: string, key: string): Promise<void> {
        delete store[ns]?.[key];
      },
    },
  } as unknown as Host;
  return { host, store };
}

beforeEach(() => {
  vi.clearAllMocks();
  readTranscriptSummary.mockReturnValue(null);
});

describe("reconcileUntitledSessions", () => {
  it("applies the agent's transcript title to a still-Untitled session (and its card)", async () => {
    readTranscriptTitle.mockReturnValue("Fix the parser");
    const { host, store } = makeHost({
      sessions: {
        s1: { id: "s1", agent: "claude", title: "Untitled", conversationId: "c1", projectId: "p1" },
      },
      cards: { card1: { id: "card1", title: "Untitled", state: "planning", sessionIds: ["s1"] } },
    });
    await reconcileUntitledSessions(host, "/cwd");
    expect(store.sessions.s1.title).toBe("Fix the parser");
    expect(store.cards.card1.title).toBe("Fix the parser");
    // Title found — no need to consult the prompt.
    expect(readUserPrompt).not.toHaveBeenCalled();
  });

  it("flags a prompted-but-untitled session so the reaper spares it", async () => {
    readTranscriptTitle.mockReturnValue(null);
    readUserPrompt.mockReturnValue("how do I do X?");
    const { host, store } = makeHost({
      sessions: {
        s1: { id: "s1", agent: "claude", title: "Untitled", conversationId: "c1", projectId: "p1" },
      },
    });
    await reconcileUntitledSessions(host, "/cwd");
    expect(store.sessions.s1.prompted).toBe(true);
    expect(store.sessions.s1.title).toBe("Untitled"); // title left for the poller
  });

  it("leaves an untitled session with no transcript activity reapable", async () => {
    readTranscriptTitle.mockReturnValue(null);
    readUserPrompt.mockReturnValue(null);
    const { host, store } = makeHost({
      sessions: {
        s1: { id: "s1", agent: "claude", title: "Untitled", conversationId: "c1", projectId: "p1" },
      },
    });
    await reconcileUntitledSessions(host, "/cwd");
    expect(store.sessions.s1.prompted).toBeUndefined();
  });

  it("never touches a session that already has a real title", async () => {
    const { host, store } = makeHost({
      sessions: {
        s1: { id: "s1", agent: "claude", title: "Real work", conversationId: "c1", projectId: "p1" },
      },
    });
    await reconcileUntitledSessions(host, "/cwd");
    expect(readTranscriptTitle).not.toHaveBeenCalled();
    expect(store.sessions.s1.title).toBe("Real work");
  });

  it("skips an untitled session with no conversationId yet (no transcript to read)", async () => {
    const { host } = makeHost({
      sessions: { s1: { id: "s1", agent: "claude", title: "Untitled", projectId: "p1" } },
    });
    await reconcileUntitledSessions(host, "/cwd");
    expect(readTranscriptTitle).not.toHaveBeenCalled();
  });
});
