import { describe, expect, it } from "vitest";
import { inferForge, compareUrl, publishWorktree, type ForgeRunner } from "../src/publishSession";
import type { GitExec } from "../src/worktrees";

const WT = "/home/u/.orden/worktrees/p1/s1";

// A scripted git: answers keyed by subcommand, recording every call.
function fakeGit(
  answers: Partial<Record<string, { stdout?: string; code?: number }>>,
): { exec: GitExec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: GitExec = (cwd, args) => {
    calls.push([cwd, ...args]);
    const a = answers[args[0] === "remote" ? "remote" : args[0]];
    return Promise.resolve({ stdout: a?.stdout ?? "", code: a?.code ?? 0 });
  };
  return { exec, calls };
}

describe("inferForge", () => {
  it("github remotes (ssh + https) infer gh", () => {
    expect(inferForge("git@github.com:1beb/orden.git")).toBe("gh");
    expect(inferForge("https://github.com/1beb/orden.git")).toBe("gh");
  });
  it("gitlab remotes infer glab", () => {
    expect(inferForge("https://gitlab.com/x/y.git")).toBe("glab");
    expect(inferForge("git@gitlab.example.org:x/y.git")).toBe("glab");
  });
  it("unknown forges infer nothing", () => {
    expect(inferForge("https://git.sr.ht/~x/y")).toBeNull();
  });
});

describe("compareUrl", () => {
  it("builds a github compare url from ssh and https remotes", () => {
    expect(compareUrl("git@github.com:1beb/orden.git", "orden/fix")).toBe(
      "https://github.com/1beb/orden/compare/orden%2Ffix?expand=1",
    );
    expect(compareUrl("https://github.com/1beb/orden.git", "orden/fix")).toBe(
      "https://github.com/1beb/orden/compare/orden%2Ffix?expand=1",
    );
  });
  it("returns null for non-github remotes", () => {
    expect(compareUrl("https://gitlab.com/x/y.git", "b")).toBeNull();
  });
});

describe("publishWorktree", () => {
  const input = (over: Partial<Parameters<typeof publishWorktree>[0]> = {}) => ({
    workdir: WT,
    branch: "orden/fix-it",
    title: "Fix it",
    summary: "Fixed the thing.",
    prForge: "auto",
    ...over,
  });

  it("reports dirty without pushing when the tree has uncommitted changes", async () => {
    const { exec, calls } = fakeGit({ status: { stdout: " M src/a.ts\n" } });
    const r = await publishWorktree(input(), exec);
    expect(r.state).toBe("dirty");
    expect(r.branch).toBe("orden/fix-it");
    expect(calls.some((c) => c[1] === "push")).toBe(false);
  });

  it("reports no-remote when origin is missing (clean tree)", async () => {
    const { exec } = fakeGit({ status: { stdout: "" }, remote: { code: 2 } });
    const r = await publishWorktree(input(), exec);
    expect(r.state).toBe("no-remote");
  });

  it("pushes and reports pushed + compareUrl with forge none", async () => {
    const { exec, calls } = fakeGit({
      status: { stdout: "" },
      remote: { stdout: "git@github.com:1beb/orden.git\n" },
      push: { code: 0 },
    });
    const r = await publishWorktree(input({ prForge: "none" }), exec);
    expect(r.state).toBe("pushed");
    expect(r.compareUrl).toContain("github.com/1beb/orden/compare");
    const push = calls.find((c) => c[1] === "push");
    expect(push).toEqual([WT, "push", "-u", "origin", "orden/fix-it"]);
  });

  it("reports push-failed with the error when the push exits non-zero", async () => {
    const { exec } = fakeGit({
      status: { stdout: "" },
      remote: { stdout: "git@github.com:1beb/orden.git\n" },
      push: { code: 128, stdout: "auth required" },
    });
    const r = await publishWorktree(input(), exec);
    expect(r.state).toBe("push-failed");
    expect(r.error).toContain("auth required");
  });

  it("opens a PR via the inferred forge CLI and parses the URL", async () => {
    const { exec } = fakeGit({
      status: { stdout: "" },
      remote: { stdout: "git@github.com:1beb/orden.git\n" },
      push: { code: 0 },
    });
    const forgeCalls: string[][] = [];
    const forge: ForgeRunner = (cwd, cli, args) => {
      forgeCalls.push([cwd, cli, ...args]);
      return Promise.resolve({
        stdout: "Creating PR…\nhttps://github.com/1beb/orden/pull/42\n",
        code: 0,
      });
    };
    const r = await publishWorktree(input(), exec, forge);
    expect(r.state).toBe("pr-opened");
    expect(r.prUrl).toBe("https://github.com/1beb/orden/pull/42");
    expect(forgeCalls[0][1]).toBe("gh");
    expect(forgeCalls[0]).toContain("Fix it");
  });

  it("falls back to pushed when the forge CLI fails", async () => {
    const { exec } = fakeGit({
      status: { stdout: "" },
      remote: { stdout: "git@github.com:1beb/orden.git\n" },
      push: { code: 0 },
    });
    const forge: ForgeRunner = () => Promise.resolve({ stdout: "gh: not logged in", code: 1 });
    const r = await publishWorktree(input(), exec, forge);
    expect(r.state).toBe("pushed");
    expect(r.compareUrl).toContain("compare");
    expect(r.error).toContain("not logged in");
  });

  it("skips the PR for an unknown forge even on auto", async () => {
    const { exec } = fakeGit({
      status: { stdout: "" },
      remote: { stdout: "https://git.sr.ht/~x/y\n" },
      push: { code: 0 },
    });
    const forgeCalls: string[][] = [];
    const forge: ForgeRunner = (cwd, cli, args) => {
      forgeCalls.push([cwd, cli, ...args]);
      return Promise.resolve({ stdout: "", code: 0 });
    };
    const r = await publishWorktree(input(), exec, forge);
    expect(r.state).toBe("pushed");
    expect(r.compareUrl).toBeUndefined();
    expect(forgeCalls.length).toBe(0);
  });
});
