import type { VaultStore } from "@orden/host-api";

export function fakeVault(seed: Record<string, Record<string, unknown>> = {}): VaultStore {
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
