import { describe, it, expect } from "vitest";
import {
  enqueueOnComplete,
  readReadyQueue,
  drain,
  resumeOnResolve,
  type CoordinatorGit,
  type CoordinatorDeps,
  type DrainPlan,
  type ResolverInput,
  type ResolverOutcome,
  type TerminalContext,
} from "../src/mergeCoordinator";
import { INTEGRATION_BRANCH } from "../src/integrationBranch";
import { MERGE_QUEUE_NS, type MergeQueueEntry } from "../src/mergeTypes";
import type { VaultStore } from "@orden/host-api";

function makeVault(): VaultStore {
  const data = new Map<string, Map<string, unknown>>();
  const ns = (n: string) => {
    if (!data.has(n)) data.set(n, new Map());
    return data.get(n)!;
  };
  return {
    get: async <T>(n: string, k: string) => (ns(n).get(k) ?? null) as T | null,
    set: async (n: string, k: string, v: unknown) => void ns(n).set(k, v),
    list: async (n: string) => [...ns(n).keys()],
    delete: async (n: string, k: string) => void ns(n).delete(k),
  };
}

interface GitOpts {
  conflicts?: Record<string, string[]>; // branch -> conflicted files
  changed?: Record<string, string[]>; // branch -> changed files
}
function makeGit(opts: GitOpts = {}) {
  const calls = { applied: [] as string[], reset: [] as string[] };
  let n = 0;
  const git: CoordinatorGit = {
    ensureIntegrationWorktree: async () => ({ workdir: "/wt", branch: INTEGRATION_BRANCH, tip: "tip0" }),
    previewMerge: async (_c, _into, incoming) => {
      const cf = opts.conflicts?.[incoming] ?? [];
      return cf.length ? { clean: false, conflictFiles: cf } : { clean: true, conflictFiles: [] };
    },
    applyClean: async (_c, incoming) => {
      calls.applied.push(incoming);
      return `tip${++n}`;
    },
    resetIntegration: async (_c, prior) => void calls.reset.push(prior),
    currentTip: async () => `tip${++n}`,
    changedFiles: async (_c, _base, branch) => opts.changed?.[branch] ?? [],
  };
  return { git, calls };
}

const plan = (
  mode: "fast" | "measured" = "fast",
  verify = "test",
): ((p: string) => Promise<DrainPlan>) =>
  async () => ({ repo: "/repo", integrationRoot: "/wt", base: "main", verify, rebuild: "", mode, project: null });

async function seedCard(
  vault: VaultStore,
  id: string,
  over: Record<string, unknown> = {},
): Promise<void> {
  await vault.set("cards", id, {
    id,
    title: `card ${id}`,
    state: "complete",
    projectId: "P",
    branch: `orden/${id}`,
    completedAt: 1,
    ...over,
  });
}

describe("enqueueOnComplete", () => {
  it("writes one queued entry for a completed, branched card; idempotent", async () => {
    const v = makeVault();
    await seedCard(v, "a", { completedAt: 5 });
    await enqueueOnComplete(v, "a");
    await enqueueOnComplete(v, "a");
    const keys = await v.list(MERGE_QUEUE_NS);
    expect(keys).toEqual(["a"]);
    const e = await v.get<MergeQueueEntry>(MERGE_QUEUE_NS, "a");
    expect(e).toMatchObject({ cardId: "a", projectId: "P", branch: "orden/a", enqueuedAt: 5, status: "queued" });
  });
  it("falls back to the linked session's branch when the card has no stamp", async () => {
    const v = makeVault();
    await seedCard(v, "a", { branch: undefined, sessionIds: ["s1"] });
    await v.set("sessions", "s1", { id: "s1", branch: "orden/from-session" });
    await enqueueOnComplete(v, "a");
    expect((await v.get<MergeQueueEntry>(MERGE_QUEUE_NS, "a"))!.branch).toBe("orden/from-session");
  });
  it("skips a card with no branch anywhere", async () => {
    const v = makeVault();
    await seedCard(v, "a", { branch: undefined });
    await enqueueOnComplete(v, "a");
    expect(await v.list(MERGE_QUEUE_NS)).toEqual([]);
  });
});

describe("readReadyQueue", () => {
  it("returns this project's queued entries FIFO by enqueuedAt", async () => {
    const v = makeVault();
    await seedCard(v, "a", { completedAt: 30 });
    await seedCard(v, "b", { completedAt: 10 });
    await seedCard(v, "c", { completedAt: 20, projectId: "OTHER" });
    await enqueueOnComplete(v, "a");
    await enqueueOnComplete(v, "b");
    await enqueueOnComplete(v, "c");
    const ready = await readReadyQueue(v, "P");
    expect(ready.map((e) => e.cardId)).toEqual(["b", "a"]); // c is a different project
  });
});

const baseDeps = (
  vault: VaultStore,
  git: CoordinatorGit,
  over: Partial<CoordinatorDeps> = {},
): CoordinatorDeps => ({
  vault,
  git,
  resolver: async () => ({ kind: "resolved" }),
  gate: async () => ({ green: true, output: "" }),
  plan: plan(),
  terminalStep: async () => {},
  ...over,
});

describe("drain — all clean", () => {
  it("merges every branch FIFO and runs the terminal step once with all merged ids", async () => {
    const v = makeVault();
    await seedCard(v, "a", { completedAt: 1 });
    await seedCard(v, "b", { completedAt: 2 });
    await enqueueOnComplete(v, "a");
    await enqueueOnComplete(v, "b");
    const { git, calls } = makeGit();
    let term: TerminalContext | null = null;
    await drain(baseDeps(v, git, { terminalStep: async (c) => void (term = c) }), "P");

    expect(calls.applied).toEqual(["orden/a", "orden/b"]);
    expect(term!.mergedCardIds).toEqual(["a", "b"]);
    expect(term!.mode).toBe("fast");
    expect((await v.get<MergeQueueEntry>(MERGE_QUEUE_NS, "a"))!.status).toBe("merged");
    expect((await v.get<Record<string, unknown>>("cards", "b"))!.mergeStatus).toBe("merged");
  });
});

describe("drain — no verify command", () => {
  it("merges on a clean textual merge without running any gate (toolchain-agnostic)", async () => {
    const v = makeVault();
    await seedCard(v, "a");
    await enqueueOnComplete(v, "a");
    const { git } = makeGit();
    let gateCalls = 0;
    await drain(
      baseDeps(v, git, {
        plan: plan("fast", ""), // no verify command configured
        gate: async () => (gateCalls++, { green: true, output: "" }),
      }),
      "P",
    );
    expect(gateCalls).toBe(0); // gate skipped — we don't know how to test this project
    expect((await v.get<MergeQueueEntry>(MERGE_QUEUE_NS, "a"))!.status).toBe("merged");
  });
});

describe("drain — conflict resolved", () => {
  it("a resolved conflict that gates green is merged with result 'resolved'", async () => {
    const v = makeVault();
    await seedCard(v, "a");
    await enqueueOnComplete(v, "a");
    const { git } = makeGit({ conflicts: { "orden/a": ["x.ts"] } });
    await drain(baseDeps(v, git, { resolver: async () => ({ kind: "resolved" }) }), "P");
    const e = await v.get<MergeQueueEntry>(MERGE_QUEUE_NS, "a");
    expect(e).toMatchObject({ status: "merged", result: "resolved" });
  });
});

describe("drain — intent conflict escalates and continues", () => {
  it("blocks the colliding card with the contributing sibling, resets, and keeps draining", async () => {
    const v = makeVault();
    await seedCard(v, "a", { completedAt: 1 }); // applies clean first, owns x.ts
    await seedCard(v, "b", { completedAt: 2 }); // conflicts on x.ts with a
    await enqueueOnComplete(v, "a");
    await enqueueOnComplete(v, "b");
    const { git, calls } = makeGit({
      conflicts: { "orden/b": ["x.ts"] },
      changed: { "orden/a": ["x.ts"] },
    });
    let seenInput: ResolverInput | null = null;
    const resolver = async (input: ResolverInput): Promise<ResolverOutcome> => {
      seenInput = input;
      return { kind: "intent-conflict", question: "a removes X, b needs X — which wins?", options: ["a wins", "b wins"] };
    };
    await drain(baseDeps(v, git, { resolver }), "P");

    // a merged, b escalated
    expect((await v.get<MergeQueueEntry>(MERGE_QUEUE_NS, "a"))!.status).toBe("merged");
    const be = await v.get<MergeQueueEntry>(MERGE_QUEUE_NS, "b");
    expect(be).toMatchObject({ status: "escalated", result: "intent-conflict" });
    const bcard = await v.get<Record<string, unknown>>("cards", "b");
    expect(bcard!.state).toBe("blocked");
    expect(bcard!.mergeStatus).toBe("blocked-intent");
    expect((bcard!.integrationBlock as { otherCardIds: string[] }).otherCardIds).toEqual(["a"]);
    // resolver was handed a's intent as the contributor
    expect(seenInput!.contributors.map((c) => c.cardId)).toEqual(["a"]);
    // integration was reset after the escalation
    expect(calls.reset.length).toBe(1);
  });
});

describe("drain — gate red is unverifiable", () => {
  it("blocks the card, records the error, resets to the prior tip", async () => {
    const v = makeVault();
    await seedCard(v, "a");
    await enqueueOnComplete(v, "a");
    const { git, calls } = makeGit();
    let term = false;
    await drain(
      baseDeps(v, git, {
        gate: async () => ({ green: false, output: "TYPECHECK FAILED" }),
        terminalStep: async () => void (term = true),
      }),
      "P",
    );
    const e = await v.get<MergeQueueEntry>(MERGE_QUEUE_NS, "a");
    expect(e).toMatchObject({ status: "escalated", result: "unverifiable" });
    expect(e!.error).toContain("TYPECHECK FAILED");
    expect((await v.get<Record<string, unknown>>("cards", "a"))!.mergeStatus).toBe("blocked-unverifiable");
    expect(calls.reset.length).toBe(1);
    expect(term).toBe(false); // nothing merged → no terminal step
  });
});

describe("resumeOnResolve — intent decision", () => {
  it("finalizes the losers, re-enqueues the winner, and re-drains", async () => {
    const v = makeVault();
    // a is already merged; b is blocked, asking a-vs-b; user picks b as winner.
    await seedCard(v, "a", { completedAt: 1, mergeStatus: "merged" });
    await seedCard(v, "b", {
      completedAt: 2,
      state: "blocked",
      mergeStatus: "blocked-intent",
      integrationBlock: { kind: "intent", question: "?", options: ["a", "b"], otherCardIds: ["a"], chosen: "b" },
    });
    const { git } = makeGit();
    let drained = false;
    await resumeOnResolve(
      baseDeps(v, git, {
        // detect the re-drain via the terminal step firing for the re-enqueued winner
        terminalStep: async () => void (drained = true),
      }),
      "b",
    );

    // loser a is finalized with a note and its queue entry dropped
    const a = await v.get<Record<string, unknown>>("cards", "a");
    expect(a!.integrationNote).toContain("superseded by card b");
    expect(await v.get(MERGE_QUEUE_NS, "a")).toBeNull();
    // winner b is re-queued (block cleared) and the drain ran
    const be = await v.get<MergeQueueEntry>(MERGE_QUEUE_NS, "b");
    expect(be).toMatchObject({ cardId: "b", status: "merged" }); // re-drain merged it clean
    expect(drained).toBe(true);
  });

  it("ignores a blocked card with no chosen winner yet", async () => {
    const v = makeVault();
    await seedCard(v, "b", {
      state: "blocked",
      integrationBlock: { kind: "intent", question: "?", options: ["a", "b"], otherCardIds: ["a"] },
    });
    const { git, calls } = makeGit();
    await resumeOnResolve(baseDeps(v, git), "b");
    expect(calls.applied).toEqual([]); // no drain
  });
});
