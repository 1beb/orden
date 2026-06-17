import { describe, it, expect } from "vitest";
import {
  ensureIntegrationWorktree,
  previewMerge,
  applyClean,
  resetIntegration,
  stackOnto,
  currentTip,
  changedFiles,
  runGate,
  INTEGRATION_BRANCH,
  type GateRunner,
} from "../src/integrationBranch";
import type { GitExec } from "../src/worktrees";

// A GitExec that records calls and answers by arg-prefix match.
function recordingExec(responses: Record<string, { stdout?: string; code?: number }> = {}) {
  const calls: string[][] = [];
  const exec: GitExec = async (_cwd, args) => {
    calls.push(args);
    const key = args.join(" ");
    const hit = Object.entries(responses).find(([k]) => key.startsWith(k));
    return { stdout: hit?.[1].stdout ?? "", code: hit?.[1].code ?? 0 };
  };
  return { exec, calls };
}

describe("ensureIntegrationWorktree", () => {
  it("creates the worktree off base when it does not exist and returns path + branch + tip", async () => {
    const { exec, calls } = recordingExec({ "rev-parse HEAD": { stdout: "abc123\n" } });
    // integrationRoot points at a path that does not exist → create branch
    const res = await ensureIntegrationWorktree(
      { repo: "/repo", integrationRoot: "/definitely/missing/_integration", base: "main" },
      exec,
    );
    expect(res).toEqual({
      workdir: "/definitely/missing/_integration",
      branch: INTEGRATION_BRANCH,
      tip: "abc123",
    });
    expect(calls.some((a) => a[0] === "worktree" && a.includes(INTEGRATION_BRANCH))).toBe(true);
  });
});

describe("previewMerge", () => {
  it("reports clean when merge-tree exits 0", async () => {
    const { exec } = recordingExec({ "merge-tree": { stdout: "treeoid\n", code: 0 } });
    expect(await previewMerge("/wt", INTEGRATION_BRANCH, "orden/feat-a", exec)).toEqual({
      clean: true,
      conflictFiles: [],
    });
  });
  it("lists conflicted files (skipping the tree-oid line) when merge-tree exits nonzero", async () => {
    const { exec } = recordingExec({
      "merge-tree": {
        stdout: "treeoid\napps/web/src/main.ts\napps/host/src/terminal.ts\n",
        code: 1,
      },
    });
    expect(await previewMerge("/wt", INTEGRATION_BRANCH, "orden/feat-a", exec)).toEqual({
      clean: false,
      conflictFiles: ["apps/web/src/main.ts", "apps/host/src/terminal.ts"],
    });
  });
});

describe("applyClean", () => {
  it("merges incoming with --no-ff and returns the new tip", async () => {
    const { exec, calls } = recordingExec({ "rev-parse HEAD": { stdout: "newtip\n" } });
    const tip = await applyClean("/wt", "orden/feat-a", "merge A", exec);
    expect(tip).toBe("newtip");
    const merge = calls.find((a) => a[0] === "merge");
    expect(merge).toBeDefined();
    expect(merge).toContain("--no-ff");
    expect(merge).toContain("orden/feat-a");
  });
});

describe("stackOnto", () => {
  it("cherry-picks base..incoming onto the current tip and returns the new tip on a clean stack", async () => {
    const { exec, calls } = recordingExec({ "rev-parse HEAD": { stdout: "stacktip\n" } });
    const res = await stackOnto("/wt", "main", "orden/feat-b", exec);
    expect(res).toEqual({ clean: true, tip: "stacktip" });
    const cp = calls.find((a) => a[0] === "cherry-pick");
    expect(cp).toContain("main..orden/feat-b");
  });

  it("aborts and reports the unmerged files when the cherry-pick series conflicts", async () => {
    const { exec, calls } = recordingExec({
      "cherry-pick main": { code: 1 },
      "diff --name-only --diff-filter=U": { stdout: "x.ts\ny.ts\n" },
    });
    const res = await stackOnto("/wt", "main", "orden/feat-b", exec);
    expect(res).toEqual({ clean: false, conflictFiles: ["x.ts", "y.ts"] });
    expect(calls.some((a) => a[0] === "cherry-pick" && a.includes("--abort"))).toBe(true);
  });
});

describe("resetIntegration", () => {
  it("aborts any in-progress merge then hard-resets to the prior tip", async () => {
    const { exec, calls } = recordingExec();
    await resetIntegration("/wt", "priortip", exec);
    expect(calls).toEqual([
      ["merge", "--abort"],
      ["reset", "--hard", "priortip"],
    ]);
  });
});

describe("currentTip", () => {
  it("returns the trimmed HEAD oid", async () => {
    const { exec } = recordingExec({ "rev-parse HEAD": { stdout: "deadbeef\n" } });
    expect(await currentTip("/wt", exec)).toBe("deadbeef");
  });
});

describe("changedFiles", () => {
  it("lists files a branch changed vs the base", async () => {
    const { exec, calls } = recordingExec({ "diff --name-only": { stdout: "a.ts\nb.ts\n" } });
    expect(await changedFiles("/wt", "main", "orden/feat-a", exec)).toEqual(["a.ts", "b.ts"]);
    expect(calls[0]).toEqual(["diff", "--name-only", "main...orden/feat-a"]);
  });
});

describe("runGate", () => {
  it("is green on a zero-exit runner", async () => {
    const runner: GateRunner = async () => ({ code: 0, output: "ok" });
    expect(await runGate("/wt", "pnpm -r test", runner)).toEqual({ green: true, output: "ok" });
  });
  it("is red with output on a nonzero runner", async () => {
    const runner: GateRunner = async () => ({ code: 1, output: "boom" });
    expect(await runGate("/wt", "pnpm -r test", runner)).toEqual({ green: false, output: "boom" });
  });
});
