import { describe, test, expect, beforeEach } from "vitest";
import type { Host } from "@orden/host-api";
import { journalCompletedCard } from "../src/cardJournal";

// Mirror @orden/outliner's journalKey default-zone formatting (host's own zone,
// no override). Inlined rather than imported because apps/host doesn't resolve
// the @orden/outliner/page subpath in its test runner — it reaches journalKey
// transitively through @orden/mcp at runtime, which is all production needs.
const journalKey = (d: Date): string => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const get = (t: "year" | "month" | "day") => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
};

// Minimal host: an in-memory cards + pages store. The journaler reads the card
// and writes its completion entries through the same vault, so a read/write
// fake over two namespaces is enough.
function makeHost() {
  const ns: Record<string, Map<string, unknown>> = { cards: new Map(), pages: new Map(), projects: new Map(), settings: new Map() };
  const host = {
    vault: {
      async get<T>(n: string, key: string): Promise<T | null> {
        return (ns[n]?.get(key) as T) ?? null;
      },
      async set<T>(n: string, key: string, value: T): Promise<void> {
        (ns[n] ??= new Map()).set(key, value);
      },
      async list(n: string): Promise<string[]> {
        return [...(ns[n]?.keys() ?? [])];
      },
    },
  } as unknown as Host;
  return { host, ns };
}

const AT = 1780690172706; // 2026-06-05T20:09:32Z

describe("journalCompletedCard", () => {
  let journaled: Set<string>;
  beforeEach(() => {
    journaled = new Set();
  });

  test("writes a journal entry when a card is completed via the web path (no summary)", async () => {
    const { host, ns } = makeHost();
    ns.projects.set("p", { id: "p", name: "Alpha" });
    ns.cards.set("c1", { id: "c1", title: "Fix login", state: "complete", completedAt: AT, projectId: "p" });
    await journalCompletedCard(host, "c1", journaled);
    const journal = (await host.vault.get<string>("pages", journalKey(new Date(AT)))) ?? "";
    expect(journal).toContain('Completed "Fix login"');
    expect(journal).toContain("[[Project: Alpha]]");
  });

  test("is idempotent: a re-write of an already-complete card does not duplicate", async () => {
    const { host, ns } = makeHost();
    ns.cards.set("c1", { id: "c1", title: "Fix login", state: "complete", completedAt: AT });
    await journalCompletedCard(host, "c1", journaled);
    await journalCompletedCard(host, "c1", journaled); // second change event for the same completion
    const journal = (await host.vault.get<string>("pages", journalKey(new Date(AT)))) ?? "";
    expect((journal.match(/Completed "Fix login"/g) ?? []).length).toBe(1);
  });

  test("ignores cards that aren't complete and forgets them so a later completion logs", async () => {
    const { host, ns } = makeHost();
    ns.cards.set("c1", { id: "c1", title: "Fix login", state: "in-progress" });
    await journalCompletedCard(host, "c1", journaled);
    expect(await host.vault.get<string>("pages", journalKey(new Date(AT)))).toBeNull();
    // Now it completes — the journaler must act.
    ns.cards.set("c1", { id: "c1", title: "Fix login", state: "complete", completedAt: AT });
    await journalCompletedCard(host, "c1", journaled);
    const journal = (await host.vault.get<string>("pages", journalKey(new Date(AT)))) ?? "";
    expect(journal).toContain('Completed "Fix login"');
  });
});
