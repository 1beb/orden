import { describe, test, expect, beforeEach } from "vitest";
import type { Host } from "@orden/host-api";
import { reapCompletedCard } from "../src/cardReaper";

// Minimal host: an in-memory cards store + a kill spy. The reaper only touches
// host.vault.get and host.sessions.kill.
function makeHost() {
  const cards = new Map<string, unknown>();
  const killed: string[] = [];
  const host = {
    vault: {
      async get<T>(ns: string, key: string): Promise<T | null> {
        return ns === "cards" ? ((cards.get(key) as T) ?? null) : null;
      },
    },
    sessions: {
      async kill(id: string): Promise<void> {
        killed.push(id);
      },
    },
  } as unknown as Host;
  return { host, cards, killed };
}

describe("reapCompletedCard", () => {
  let reaped: Set<string>;
  beforeEach(() => {
    reaped = new Set();
  });

  test("kills every linked session when a card is complete", async () => {
    const { host, cards, killed } = makeHost();
    cards.set("c1", { id: "c1", state: "complete", sessionIds: ["s1", "s2"] });
    await reapCompletedCard(host, "c1", reaped);
    expect(killed).toEqual(["s1", "s2"]);
  });

  test("ignores cards that aren't complete", async () => {
    const { host, cards, killed } = makeHost();
    cards.set("c1", { id: "c1", state: "in-progress", sessionIds: ["s1"] });
    await reapCompletedCard(host, "c1", reaped);
    expect(killed).toEqual([]);
  });

  test("tolerates the legacy single-sessionId shape", async () => {
    const { host, cards, killed } = makeHost();
    cards.set("c1", { id: "c1", state: "complete", sessionId: "s9" });
    await reapCompletedCard(host, "c1", reaped);
    expect(killed).toEqual(["s9"]);
  });

  test("reaps a completion only once", async () => {
    const { host, cards, killed } = makeHost();
    cards.set("c1", { id: "c1", state: "complete", sessionIds: ["s1"] });
    await reapCompletedCard(host, "c1", reaped);
    await reapCompletedCard(host, "c1", reaped); // re-write to an already-complete card
    expect(killed).toEqual(["s1"]);
  });

  test("re-reaps after a card leaves and re-enters complete", async () => {
    const { host, cards, killed } = makeHost();
    cards.set("c1", { id: "c1", state: "complete", sessionIds: ["s1"] });
    await reapCompletedCard(host, "c1", reaped);
    cards.set("c1", { id: "c1", state: "in-progress", sessionIds: ["s1"] });
    await reapCompletedCard(host, "c1", reaped); // leaving Done clears the guard
    cards.set("c1", { id: "c1", state: "complete", sessionIds: ["s1"] });
    await reapCompletedCard(host, "c1", reaped);
    expect(killed).toEqual(["s1", "s1"]);
  });

  test("is a no-op for a missing card", async () => {
    const { host, killed } = makeHost();
    await reapCompletedCard(host, "nope", reaped);
    expect(killed).toEqual([]);
  });
});
