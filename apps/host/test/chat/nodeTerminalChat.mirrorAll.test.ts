import { describe, it, expect } from "vitest";
import type { Host } from "@orden/host-api";
import { NodeTerminalChat } from "../../src/chat/nodeTerminalChat";
import type { PaneOps } from "../../src/annotationDelivery";

// mirrorAll() runs once at boot. It must only eagerly mirror sessions whose agent
// pane is LIVE: a dead session's transcript never changes, so starting a
// TranscriptMirror for it is pure waste — and at scale (100+ sessions) the
// fan-out of full-file re-parses + vault writes saturates the CPU. Dead sessions
// mirror lazily on open (chatMount). These tests pin the live-only filter; the
// fake PaneOps means no tmux/fs runs.

const CWD = "/tmp/orden-fake-cwd";

function hostWith(sessionIds: string[]): Host {
  const sessions = new Map<string, unknown>(
    sessionIds.map((id) => [id, { id, agent: "claude", conversationId: `conv-${id}` }]),
  );
  return {
    vault: {
      async get<T>(_ns: string, key: string) {
        return (sessions.get(key) ?? null) as T | null;
      },
      async set() {},
      async list() {
        return [...sessions.keys()];
      },
      async delete() {},
    },
  } as unknown as Host;
}

function paneOpsLive(live: Set<string>, opts: { throwOn?: Set<string> } = {}): PaneOps {
  return {
    async isLive(id) {
      if (opts.throwOn?.has(id)) throw new Error(`tmux blew up for ${id}`);
      return live.has(id);
    },
    async sendText() {},
    async sendKeys() {},
    async relaunch() {},
  };
}

// Replace the real mirror() (which builds fs.watch-backed mirrors) with a recorder.
function recordingChat(host: Host, ops: PaneOps): { chat: NodeTerminalChat; mirrored: string[] } {
  const chat = new NodeTerminalChat(host, CWD, { paneOps: ops });
  const mirrored: string[] = [];
  (chat as unknown as { mirror: (id: string) => Promise<boolean> }).mirror = async (id) => {
    mirrored.push(id);
    return true;
  };
  return { chat, mirrored };
}

describe("NodeTerminalChat.mirrorAll", () => {
  it("only mirrors sessions with a live agent pane", async () => {
    const host = hostWith(["a", "b", "c"]);
    const { chat, mirrored } = recordingChat(host, paneOpsLive(new Set(["a", "c"])));
    await chat.mirrorAll();
    expect(mirrored).toEqual(["a", "c"]);
  });

  it("mirrors nothing when no session is live", async () => {
    const host = hostWith(["a", "b"]);
    const { chat, mirrored } = recordingChat(host, paneOpsLive(new Set()));
    await chat.mirrorAll();
    expect(mirrored).toEqual([]);
  });

  it("a liveness probe that throws skips that session, not the rest", async () => {
    const host = hostWith(["a", "b", "c"]);
    const ops = paneOpsLive(new Set(["a", "b", "c"]), { throwOn: new Set(["b"]) });
    const { chat, mirrored } = recordingChat(host, ops);
    await chat.mirrorAll();
    expect(mirrored).toEqual(["a", "c"]);
  });
});
