import { describe, it, expect } from "vitest";
import type { Host } from "@orden/host-api";
import {
  NodeTerminalChat,
  questionSpecsFromTranscript,
} from "../../src/chat/nodeTerminalChat";
import type { PaneOps } from "../../src/annotationDelivery";
import type { KeyOp } from "../../src/chat/questionKeystrokes";

// answerQuestion reads the question structure from the transcript and drives the
// pane with keystrokes. These exercise that glue — spec derivation + encode +
// sendKeys — with an injected transcript + recording PaneOps, so no fs/tmux runs.
// The encoder's exact keystrokes are covered in questionKeystrokes.test.ts.

const CONV = "conv-xyz";
const CWD = "/tmp/orden-fake-cwd";

// A transcript line with one AskUserQuestion: a single-select (2 options) and a
// multiSelect (3 options).
function transcript(toolId: string): string {
  return (
    JSON.stringify({
      type: "assistant",
      message: {
        id: "m1",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: toolId,
            name: "AskUserQuestion",
            input: {
              questions: [
                { header: "Size", multiSelect: false, options: [{ label: "S" }, { label: "L" }] },
                {
                  header: "Tops",
                  multiSelect: true,
                  options: [{ label: "A" }, { label: "B" }, { label: "C" }],
                },
              ],
            },
          },
        ],
      },
    }) + "\n"
  );
}

function hostWith(sessions: Record<string, unknown>): Host {
  const store = new Map<string, Map<string, unknown>>([["sessions", new Map(Object.entries(sessions))]]);
  const nsMap = (ns: string) => store.get(ns) ?? store.set(ns, new Map()).get(ns)!;
  return {
    vault: {
      async get<T>(ns: string, key: string) {
        return (nsMap(ns).get(key) ?? null) as T | null;
      },
      async set<T>(ns: string, key: string, value: T) {
        nsMap(ns).set(key, value);
      },
      async list(ns: string) {
        return [...nsMap(ns).keys()];
      },
      async delete(ns: string, key: string) {
        nsMap(ns).delete(key);
      },
    },
  } as unknown as Host;
}

const seq = (ops: KeyOp[]) =>
  ops.map((o) => (o.type === "literal" ? o.value : `<${o.name}>`)).join("");

function chatFor(toolId: string, sent: KeyOp[][], sessions?: Record<string, unknown>) {
  const host = hostWith(sessions ?? { s1: { id: "s1", agent: "claude", conversationId: CONV } });
  const ops: PaneOps = {
    async isLive() {
      return true;
    },
    async sendText() {},
    async sendKeys(_id, keys) {
      sent.push(keys);
    },
    async relaunch() {},
  };
  return new NodeTerminalChat(host, CWD, { paneOps: ops, readTranscript: () => transcript(toolId) });
}

describe("questionSpecsFromTranscript", () => {
  it("derives option counts + multiSelect flags by tool id", () => {
    expect(questionSpecsFromTranscript(transcript("t9"), "t9")).toEqual([
      { optionCount: 2, multiSelect: false },
      { optionCount: 3, multiSelect: true },
    ]);
  });
  it("returns null for an unknown tool id", () => {
    expect(questionSpecsFromTranscript(transcript("t9"), "nope")).toBeNull();
  });
});

describe("NodeTerminalChat.answerQuestion", () => {
  it("reads the transcript and sends the encoded keystrokes for a submit", async () => {
    const sent: KeyOp[][] = [];
    const tc = chatFor("toolu_1", sent);
    await tc.answerQuestion("s1", "toolu_1", {
      kind: "submit",
      answers: [
        { kind: "option", index: 1 }, // Size = L -> '2' (auto-advances)
        { kind: "multi", indexes: [0, 2] }, // Tops A,C -> '1','3', Right, review '1'
      ],
    });
    expect(sent.length).toBe(1);
    expect(seq(sent[0])).toBe("2" + "13" + "<Right>" + "1");
  });

  it("encodes a chat decline as the N+2 entry on the first question", async () => {
    const sent: KeyOp[][] = [];
    const tc = chatFor("toolu_2", sent);
    await tc.answerQuestion("s1", "toolu_2", { kind: "chat" });
    expect(seq(sent[0])).toBe("4"); // 2 options -> "Chat about this" is option 4
  });

  it("throws when the tool id isn't a question in the transcript", async () => {
    const sent: KeyOp[][] = [];
    const tc = chatFor("toolu_real", sent);
    await expect(tc.answerQuestion("s1", "missing", { kind: "chat" })).rejects.toThrow(
      /no AskUserQuestion/,
    );
  });
});
