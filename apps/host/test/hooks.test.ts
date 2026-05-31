import { describe, test, expect } from "vitest";
import type { Host, VaultStore } from "@orden/host-api";
import { applyState } from "../src/hooks";

// Minimal in-memory vault (mirrors packages/mcp/test/fakeVault) so we can drive
// applyState without disk. Only get/set/list/delete are exercised by the helpers.
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

// applyState only touches host.vault — a vault-only host is enough.
const hostWith = (vault: VaultStore): Host => ({ vault }) as unknown as Host;

describe("applyState (hooks → card state)", () => {
  test("leaves a completed card at 'complete' (terminal, user/LLM-owned)", async () => {
    const vault = fakeVault({
      sessions: { s1: { id: "s1", conversationId: "uuid-1" } },
      cards: { c1: { id: "c1", title: "T", state: "complete", sessionIds: ["s1"] } },
    });
    await applyState(hostWith(vault), "uuid-1", "blocked");
    const card = await vault.get<{ state: string }>("cards", "c1");
    expect(card?.state).toBe("complete");
  });

  test("moves an in-progress card to blocked", async () => {
    const vault = fakeVault({
      sessions: { s1: { id: "s1", conversationId: "uuid-1" } },
      cards: { c1: { id: "c1", title: "T", state: "in-progress", sessionIds: ["s1"] } },
    });
    await applyState(hostWith(vault), "uuid-1", "blocked");
    const card = await vault.get<{ state: string }>("cards", "c1");
    expect(card?.state).toBe("blocked");
  });

  test("unknown conversation id is a no-op (no throw)", async () => {
    const vault = fakeVault({ sessions: {}, cards: {} });
    await expect(applyState(hostWith(vault), "nope", "blocked")).resolves.toBeUndefined();
  });
});
