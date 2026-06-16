import { describe, it, expect } from "vitest";
import {
  conservativeResolver,
  buildResolverPrompt,
  outcomeFromVerdict,
  makeNodeResolver,
  awaitVerdictFromVault,
  type ResolverSpawn,
} from "../src/resolverAgent";
import type { ResolverInput } from "../src/mergeCoordinator";
import { MERGE_RESOLUTION_NS, type ResolutionVerdict } from "@orden/mcp";

const input = (over: Partial<ResolverInput> = {}): ResolverInput => ({
  integrationWorkdir: "/wt",
  projectId: "P",
  incoming: { cardId: "b", branch: "orden/b", title: "Add dark mode", planDoc: "docs/b.md" },
  contributors: [{ cardId: "a", branch: "orden/a", title: "Refactor theme", planDoc: "docs/a.md" }],
  conflictFiles: ["theme.ts"],
  ...over,
});

describe("conservativeResolver", () => {
  it("escalates every conflict as an intent decision with card ids as chip options", async () => {
    const outcome = await conservativeResolver({
      integrationWorkdir: "/wt",
      incoming: { cardId: "b", branch: "orden/b", title: "B feature" },
      contributors: [{ cardId: "a", branch: "orden/a", title: "A feature" }],
      conflictFiles: ["main.ts"],
    });
    expect(outcome.kind).toBe("intent-conflict");
    if (outcome.kind === "intent-conflict") {
      expect(outcome.options).toEqual(["b", "a"]); // incoming first, then contributors
      expect(outcome.question).toContain("B feature");
      expect(outcome.question).toContain("main.ts");
    }
  });
});

describe("buildResolverPrompt", () => {
  it("includes both intents, the conflict files, and the resolution_report protocol", () => {
    const p = buildResolverPrompt(input());
    expect(p).toContain("Add dark mode"); // incoming intent
    expect(p).toContain("Refactor theme"); // contributor intent
    expect(p).toContain("theme.ts"); // conflict files
    expect(p).toContain("resolution_report"); // the verdict protocol
  });
});

describe("outcomeFromVerdict", () => {
  it("maps a resolved verdict", () => {
    expect(outcomeFromVerdict({ kind: "resolved" }, input())).toEqual({ kind: "resolved" });
  });
  it("maps intent-conflict to card-id chip options (incoming first)", () => {
    const o = outcomeFromVerdict({ kind: "intent-conflict", question: "Whose theme wins?" }, input());
    expect(o).toMatchObject({ kind: "intent-conflict", question: "Whose theme wins?", options: ["b", "a"] });
  });
  it("maps a null verdict (timeout) and an unverifiable verdict to unverifiable", () => {
    expect(outcomeFromVerdict(null, input()).kind).toBe("unverifiable");
    expect(outcomeFromVerdict({ kind: "unverifiable", question: "no tests" }, input())).toMatchObject({
      kind: "unverifiable",
      question: "no tests",
    });
  });
});

const fakeSpawn = (verdict: ResolutionVerdict | null) => {
  const calls = { spawned: 0, reaped: [] as string[] };
  const spawn: ResolverSpawn = {
    spawn: async () => (calls.spawned++, "sess_r"),
    awaitVerdict: async () => verdict,
    reap: async (id: string) => void calls.reaped.push(id),
  };
  return { spawn, calls };
};

describe("makeNodeResolver", () => {
  it("spawns an agent, maps its verdict, and reaps the session", async () => {
    const { spawn, calls } = fakeSpawn({ kind: "resolved" });
    const o = await makeNodeResolver(spawn, conservativeResolver)(input());
    expect(o).toEqual({ kind: "resolved" });
    expect(calls.spawned).toBe(1);
    expect(calls.reaped).toEqual(["sess_r"]);
  });

  it("reaps the session even when the verdict times out (null -> unverifiable)", async () => {
    const { spawn, calls } = fakeSpawn(null);
    const o = await makeNodeResolver(spawn, conservativeResolver)(input());
    expect(o.kind).toBe("unverifiable");
    expect(calls.reaped).toEqual(["sess_r"]);
  });

  it("falls back to the conservative resolver when no plan-doc intent is available", async () => {
    const { spawn, calls } = fakeSpawn({ kind: "resolved" });
    const o = await makeNodeResolver(spawn, conservativeResolver)(
      input({
        incoming: { cardId: "b", branch: "orden/b", title: "B" },
        contributors: [{ cardId: "a", branch: "orden/a", title: "A" }],
      }),
    );
    expect(calls.spawned).toBe(0); // never spawned a live agent
    expect(o.kind).toBe("intent-conflict"); // conservative escalation
  });
});

describe("awaitVerdictFromVault", () => {
  const vaultGet = (m: Map<string, ResolutionVerdict>) =>
    ({ get: async (_ns: string, k: string) => (m.get(k) ?? null) as never }) as never;

  it("resolves immediately with a verdict already present in the vault", async () => {
    const m = new Map<string, ResolutionVerdict>([["sess_r", { kind: "resolved" }]]);
    const v = await awaitVerdictFromVault({ vault: vaultGet(m), onChange: () => () => {} }, "sess_r", 1000);
    expect(v).toEqual({ kind: "resolved" });
  });

  it("resolves when the verdict arrives on the change feed", async () => {
    const m = new Map<string, ResolutionVerdict>();
    let cb: ((c: { ns: string; key: string }) => void) | null = null;
    const p = awaitVerdictFromVault(
      { vault: vaultGet(m), onChange: (fn) => ((cb = fn), () => (cb = null)) },
      "sess_r",
      1000,
    );
    await new Promise((r) => setTimeout(r, 0)); // let the initial read settle + subscribe
    m.set("sess_r", { kind: "intent-conflict", question: "Q" });
    cb!({ ns: MERGE_RESOLUTION_NS, key: "sess_r" });
    expect(await p).toEqual({ kind: "intent-conflict", question: "Q" });
  });

  it("resolves null on timeout", async () => {
    const v = await awaitVerdictFromVault(
      { vault: vaultGet(new Map()), onChange: () => () => {} },
      "sess_r",
      5,
    );
    expect(v).toBeNull();
  });
});
