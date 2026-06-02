import type { ChatVault } from "../../src/index";

// In-memory ChatVault backed by a single Map keyed by `${ns}\t${key}`.
export class MemVault implements ChatVault {
  readonly store = new Map<string, unknown>();

  private k(ns: string, key: string): string {
    return `${ns}\t${key}`;
  }

  async get<T>(ns: string, key: string): Promise<T | null> {
    return (this.store.has(this.k(ns, key)) ? (this.store.get(this.k(ns, key)) as T) : null);
  }

  async set<T>(ns: string, key: string, value: T): Promise<void> {
    this.store.set(this.k(ns, key), value);
  }

  async list(ns: string): Promise<string[]> {
    const prefix = `${ns}\t`;
    const keys: string[] = [];
    for (const k of this.store.keys()) {
      if (k.startsWith(prefix)) keys.push(k.slice(prefix.length));
    }
    return keys.sort();
  }

  async delete(ns: string, key: string): Promise<void> {
    this.store.delete(this.k(ns, key));
  }
}
