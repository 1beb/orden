import { describe, expect, it } from "vitest";
import { publishCompletedCard } from "../src/publishReactor";
import type { Host, PublishResult } from "@orden/host-api";

// A minimal host: card/session records in a map vault, an injectable publish.
function makeHost(
  recs: { cards: Record<string, unknown>; sessions?: Record<string, unknown> },
  publishResult?: PublishResult,
): Host & { written: Record<string, unknown>; publishCalls: string[] } {
  const data = new Map<string, unknown>();
  for (const [k, v] of Object.entries(recs.cards)) data.set(`cards/${k}`, v);
  for (const [k, v] of Object.entries(recs.sessions ?? {})) data.set(`sessions/${k}`, v);
  const written: Record<string, unknown> = {};
  const publishCalls: string[] = [];
  const host = {
    written,
    publishCalls,
    vault: {
      get: async (ns: string, key: string) => data.get(`${ns}/${key}`) ?? null,
      set: async (ns: string, key: string, value: unknown) => {
        data.set(`${ns}/${key}`, value);
        written[`${ns}/${key}`] = value;
      },
      list: async () => [],
      delete: async () => {},
    },
  } as unknown as Host & { written: Record<string, unknown>; publishCalls: string[] };
  if (publishResult) {
    (host as { publish?: unknown }).publish = async (sessionId: string) => {
      publishCalls.push(sessionId);
      return publishResult;
    };
  }
  return host;
}

const completeCard = (extra: Record<string, unknown> = {}) => ({
  id: "c1",
  title: "Fix it",
  state: "complete",
  sessionIds: ["s1"],
  ...extra,
});

describe("publishCompletedCard (web drag-to-Done publish reactor)", () => {
  it("publishes once and stamps the card", async () => {
    const host = makeHost(
      {
        cards: { c1: completeCard() },
        sessions: { s1: { id: "s1", workdir: "/wt", branch: "orden/fix-it" } },
      },
      { state: "pr-opened", branch: "orden/fix-it", prUrl: "https://github.com/x/y/pull/9" },
    );
    const memo = new Set<string>();
    await publishCompletedCard(host, "c1", memo);
    expect(host.publishCalls).toEqual(["s1"]);
    const card = host.written["cards/c1"] as Record<string, unknown>;
    expect(card.publishState).toBe("pr-opened");
    expect(card.prUrl).toBe("https://github.com/x/y/pull/9");
    // Re-fire (the stamp write itself triggers the reactor): no second publish.
    await publishCompletedCard(host, "c1", memo);
    expect(host.publishCalls).toEqual(["s1"]);
  });

  it("a dirty result stamps without blocking (the drag IS the user's override)", async () => {
    const host = makeHost(
      {
        cards: { c1: completeCard() },
        sessions: { s1: { id: "s1", workdir: "/wt", branch: "orden/fix-it" } },
      },
      { state: "dirty", branch: "orden/fix-it" },
    );
    await publishCompletedCard(host, "c1", new Set());
    const card = host.written["cards/c1"] as Record<string, unknown>;
    expect(card.state).toBe("complete"); // untouched
    expect(card.publishState).toBe("dirty");
  });

  it("skips a card that already carries a publish stamp (MCP path ran)", async () => {
    const host = makeHost(
      { cards: { c1: completeCard({ publishState: "pushed" }) } },
      { state: "pushed" },
    );
    await publishCompletedCard(host, "c1", new Set());
    expect(host.publishCalls).toEqual([]);
  });

  it("skips non-complete cards and clears the memo when a card leaves complete", async () => {
    const host = makeHost(
      { cards: { c1: { ...completeCard(), state: "in-progress" } } },
      { state: "pushed" },
    );
    const memo = new Set(["c1"]);
    await publishCompletedCard(host, "c1", memo);
    expect(host.publishCalls).toEqual([]);
    expect(memo.has("c1")).toBe(false); // a future completion may publish again
  });

  it("no-ops when the host has no publish capability", async () => {
    const host = makeHost({ cards: { c1: completeCard() } });
    await publishCompletedCard(host, "c1", new Set());
    expect(host.written["cards/c1"]).toBeUndefined();
  });

  it("all-no-worktree sessions leave the card unstamped", async () => {
    const host = makeHost(
      {
        cards: { c1: completeCard() },
        sessions: { s1: { id: "s1" } },
      },
      { state: "no-worktree" },
    );
    await publishCompletedCard(host, "c1", new Set());
    expect(host.written["cards/c1"]).toBeUndefined();
  });
});
