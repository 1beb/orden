import { describe, test, expect } from "vitest";
import type { Host, VaultStore } from "@orden/host-api";
import type { SessionRec } from "@orden/mcp";
import { reconcileIdleCards, type IdleDeps } from "../src/idleReconciler";

// Minimal in-memory vault (mirrors apps/host/test/hooks.test.ts).
function fakeVault(seed: Record<string, Record<string, unknown>> = {}): VaultStore {
  const store = new Map<string, Map<string, unknown>>();
  for (const [ns, kv] of Object.entries(seed)) store.set(ns, new Map(Object.entries(kv)));
  const nsMap = (ns: string) => store.get(ns) ?? store.set(ns, new Map()).get(ns)!;
  return {
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
  };
}

const hostWith = (vault: VaultStore): Host => ({ vault }) as unknown as Host;

const NOW = 1_000_000_000_000;
const IDLE_MS = 5 * 60 * 1000;

// deps with a per-session activity table; sessions absent from it report null.
function depsFrom(activity: Record<string, number | null>): IdleDeps {
  return {
    now: () => NOW,
    idleMs: IDLE_MS,
    lastActivity: (s: SessionRec) => (s.id in activity ? activity[s.id] : null),
  };
}

describe("reconcileIdleCards (idle in-progress → blocked safety net)", () => {
  test("blocks an in-progress card whose agent has been idle past the window", async () => {
    const vault = fakeVault({
      sessions: { s1: { id: "s1", conversationId: "uuid-1" } },
      cards: { c1: { id: "c1", title: "T", state: "in-progress", sessionIds: ["s1"] } },
    });
    const moved = await reconcileIdleCards(
      hostWith(vault),
      "/cwd",
      depsFrom({ s1: NOW - IDLE_MS - 1 }),
    );
    expect(moved).toEqual(["c1"]);
    expect((await vault.get<{ state: string }>("cards", "c1"))?.state).toBe("blocked");
  });

  test("leaves an in-progress card whose agent is still active", async () => {
    const vault = fakeVault({
      sessions: { s1: { id: "s1", conversationId: "uuid-1" } },
      cards: { c1: { id: "c1", title: "T", state: "in-progress", sessionIds: ["s1"] } },
    });
    const moved = await reconcileIdleCards(hostWith(vault), "/cwd", depsFrom({ s1: NOW - 1000 }));
    expect(moved).toEqual([]);
    expect((await vault.get<{ state: string }>("cards", "c1"))?.state).toBe("in-progress");
  });

  test("never touches planning / blocked / complete cards", async () => {
    const vault = fakeVault({
      sessions: { s1: { id: "s1" }, s2: { id: "s2" }, s3: { id: "s3" } },
      cards: {
        plan: { id: "plan", title: "P", state: "planning", sessionIds: ["s1"] },
        block: { id: "block", title: "B", state: "blocked", sessionIds: ["s2"] },
        done: { id: "done", title: "D", state: "complete", sessionIds: ["s3"] },
      },
    });
    const old = NOW - IDLE_MS - 1;
    const moved = await reconcileIdleCards(
      hostWith(vault),
      "/cwd",
      depsFrom({ s1: old, s2: old, s3: old }),
    );
    expect(moved).toEqual([]);
    expect((await vault.get<{ state: string }>("cards", "plan"))?.state).toBe("planning");
    expect((await vault.get<{ state: string }>("cards", "done"))?.state).toBe("complete");
  });

  test("keeps a card in-progress if ANY linked session is still active", async () => {
    const vault = fakeVault({
      sessions: { s1: { id: "s1" }, s2: { id: "s2" } },
      cards: { c1: { id: "c1", title: "T", state: "in-progress", sessionIds: ["s1", "s2"] } },
    });
    const moved = await reconcileIdleCards(
      hostWith(vault),
      "/cwd",
      // s1 idle, s2 fresh -> the card is still alive.
      depsFrom({ s1: NOW - IDLE_MS - 1, s2: NOW - 1000 }),
    );
    expect(moved).toEqual([]);
  });

  test("leaves a card whose activity is entirely unknown (no false blocking)", async () => {
    const vault = fakeVault({
      sessions: { s1: { id: "s1" } },
      cards: { c1: { id: "c1", title: "T", state: "in-progress", sessionIds: ["s1"] } },
    });
    const moved = await reconcileIdleCards(hostWith(vault), "/cwd", depsFrom({ s1: null }));
    expect(moved).toEqual([]);
    expect((await vault.get<{ state: string }>("cards", "c1"))?.state).toBe("in-progress");
  });

  test("ignores a session-less in-progress card", async () => {
    const vault = fakeVault({
      cards: { c1: { id: "c1", title: "T", state: "in-progress", sessionIds: [] } },
    });
    const moved = await reconcileIdleCards(hostWith(vault), "/cwd", depsFrom({}));
    expect(moved).toEqual([]);
  });
});
