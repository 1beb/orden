import { describe, it, expect } from "vitest";
import { makeTerminalStep, MERGE_STATUS_NS, type MergeStatusRec } from "../src/integrationTerminal";
import { INTEGRATION_BRANCH } from "../src/integrationBranch";
import type { TerminalContext } from "../src/mergeCoordinator";
import type { GitExec } from "../src/worktrees";
import type { VaultStore } from "@orden/host-api";

function makeVault(): VaultStore {
  const m = new Map<string, unknown>();
  return {
    get: async <T>(n: string, k: string) => (m.get(`${n}/${k}`) ?? null) as T | null,
    set: async (n: string, k: string, v: unknown) => void m.set(`${n}/${k}`, v),
    list: async () => [],
    delete: async () => {},
  };
}

const ctx = (mode: "fast" | "measured"): TerminalContext => ({
  handle: { workdir: "/wt", branch: INTEGRATION_BRANCH, tip: "tipN" },
  projectId: "P",
  mode,
  mergedCardIds: ["a", "b"],
  plan: { repo: "/repo", integrationRoot: "/wt", base: "main", verify: "test", mode, project: null },
});

describe("terminal step — fast", () => {
  it("ff-merges main, rebuilds, and records the pending-push count; never publishes", async () => {
    const v = makeVault();
    const gitCalls: string[][] = [];
    const exec: GitExec = async (_cwd, args) => {
      gitCalls.push(args);
      if (args[0] === "rev-list") return { stdout: "3\n", code: 0 };
      return { stdout: "", code: 0 };
    };
    let rebuilt = false;
    let published = false;
    const step = makeTerminalStep({
      vault: v,
      exec,
      rebuild: async () => ((rebuilt = true), { code: 0, output: "" }),
      publish: async () => ((published = true), {}),
    });
    await step(ctx("fast"));

    expect(gitCalls).toContainEqual(["merge", "--ff-only", INTEGRATION_BRANCH]);
    expect(rebuilt).toBe(true);
    expect(published).toBe(false);
    const rec = await v.get<MergeStatusRec>(MERGE_STATUS_NS, "P");
    expect(rec).toMatchObject({ base: "main", pendingPush: 3, lastMode: "fast", lastMergedCardIds: ["a", "b"] });
  });
});

describe("terminal step — measured", () => {
  it("publishes (push + PR) and never touches main or rebuilds", async () => {
    const v = makeVault();
    const gitCalls: string[][] = [];
    const exec: GitExec = async (_c, args) => (gitCalls.push(args), { stdout: "", code: 0 });
    let rebuilt = false;
    const step = makeTerminalStep({
      vault: v,
      exec,
      rebuild: async () => ((rebuilt = true), { code: 0, output: "" }),
      publish: async () => ({ prUrl: "https://x/pr/1" }),
    });
    await step(ctx("measured"));

    expect(gitCalls.some((a) => a[0] === "merge")).toBe(false);
    expect(rebuilt).toBe(false);
    const rec = await v.get<MergeStatusRec>(MERGE_STATUS_NS, "P");
    expect(rec).toMatchObject({ lastMode: "measured", pendingPush: 0, prUrl: "https://x/pr/1" });
  });
});
