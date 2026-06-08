import { describe, test, expect, vi } from "vitest";
import type { Learning } from "@orden/host-api";
import { applyLearning, type ApplyDeps, type GitRunner } from "../src/applyLearning";

function makeLearning(over: Partial<Learning> = {}): Learning {
  return {
    id: "L1",
    cardId: "C1",
    projectId: "repo",
    type: "readme",
    title: "Document the thing",
    recap: "",
    targetPath: "docs/THING.md",
    op: "edit",
    proposedContent: "# Thing\n\nnew content\n",
    status: "pending",
    createdAt: 0,
    ...over,
  };
}

const NO_ROOT = Symbol("no-root");
function makeDeps(learning: Learning | null, root: string | undefined | typeof NO_ROOT = "/repo") {
  const resolved = root === NO_ROOT ? undefined : root;
  const writeFile = vi.fn(async () => {});
  const deps: ApplyDeps = {
    getLearning: async () => learning,
    writeFile,
    resolveRoot: async () => resolved,
  };
  return { deps, writeFile };
}

describe("applyLearning", () => {
  test("writes proposedContent to targetPath and reports written:true", async () => {
    const learning = makeLearning();
    const { deps, writeFile } = makeDeps(learning);
    const git: GitRunner = () => ({ code: 0, stdout: "", stderr: "" });

    const res = await applyLearning(deps, "L1", git);

    expect(writeFile).toHaveBeenCalledWith("repo", "docs/THING.md", learning.proposedContent);
    expect(res).toEqual({ written: true, committed: true, path: "docs/THING.md" });
  });

  test("git work-tree: adds and commits the target with a learning: <title> message", async () => {
    const learning = makeLearning();
    const { deps } = makeDeps(learning);
    const calls: string[][] = [];
    const git: GitRunner = (_cwd, args) => {
      calls.push(args);
      return { code: 0, stdout: "", stderr: "" };
    };

    const res = await applyLearning(deps, "L1", git);

    expect(res.committed).toBe(true);
    expect(calls).toContainEqual(["rev-parse", "--is-inside-work-tree"]);
    expect(calls).toContainEqual(["add", "--", "docs/THING.md"]);
    expect(calls).toContainEqual([
      "commit",
      "-m",
      "learning: Document the thing",
      "--",
      "docs/THING.md",
    ]);
  });

  test("not a work-tree: committed:false, written:true, no add/commit attempted", async () => {
    const learning = makeLearning();
    const { deps } = makeDeps(learning);
    const calls: string[][] = [];
    const git: GitRunner = (_cwd, args) => {
      calls.push(args);
      // rev-parse fails -> not a work tree
      return { code: 128, stdout: "", stderr: "not a git repo" };
    };

    const res = await applyLearning(deps, "L1", git);

    expect(res).toEqual({ written: true, committed: false, path: "docs/THING.md" });
    expect(calls).toEqual([["rev-parse", "--is-inside-work-tree"]]);
  });

  test("commit fails: degrades to committed:false, written:true, no throw", async () => {
    const learning = makeLearning();
    const { deps } = makeDeps(learning);
    const git: GitRunner = (_cwd, args) => {
      if (args[0] === "commit") return { code: 1, stdout: "", stderr: "nothing to commit" };
      return { code: 0, stdout: "", stderr: "" };
    };

    const res = await applyLearning(deps, "L1", git);

    expect(res).toEqual({ written: true, committed: false, path: "docs/THING.md" });
  });

  test("no project root: write-only success, committed:false, git never called", async () => {
    const learning = makeLearning();
    const { deps } = makeDeps(learning, NO_ROOT);
    let gitCalls = 0;
    const git: GitRunner = () => {
      gitCalls++;
      return { code: 0, stdout: "", stderr: "" };
    };

    const res = await applyLearning(deps, "L1", git);

    expect(res).toEqual({ written: true, committed: false, path: "docs/THING.md" });
    expect(gitCalls).toBe(0);
  });

  test("missing learning: rejects with 'learning not found'", async () => {
    const { deps } = makeDeps(null);
    await expect(applyLearning(deps, "nope")).rejects.toThrow("learning not found: nope");
  });
});
