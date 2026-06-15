import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readWorktreeSettings,
  isolationEnabled,
  worktreesRoot,
  isOrdenWorktree,
  slugify,
  defaultBaseRef,
  pickBranch,
  isGitRepo,
  ensureSessionWorktree,
  type GitExec,
} from "../src/worktrees";
import type { Project, VaultStore } from "@orden/host-api";

function memVault(initial: Record<string, Record<string, unknown>> = {}): VaultStore {
  const data = new Map<string, unknown>();
  for (const [ns, entries] of Object.entries(initial)) {
    for (const [k, v] of Object.entries(entries)) data.set(`${ns}/${k}`, v);
  }
  return {
    get: <T,>(ns: string, key: string) => Promise.resolve((data.get(`${ns}/${key}`) as T) ?? null),
    set: (ns, key, value) => {
      data.set(`${ns}/${key}`, value);
      return Promise.resolve();
    },
    list: () => Promise.resolve([]),
    delete: (ns, key) => {
      data.delete(`${ns}/${key}`);
      return Promise.resolve();
    },
  };
}

// A scripted GitExec: answers by matching the git subcommand, recording calls.
function fakeGit(
  answers: Partial<Record<string, { stdout?: string; code?: number }>>,
): { exec: GitExec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: GitExec = (cwd, args) => {
    calls.push([cwd, ...args]);
    const key = args[0] === "worktree" || args[0] === "symbolic-ref" || args[0] === "rev-parse"
      ? args[0]
      : args.join(" ");
    const a = answers[key];
    return Promise.resolve({ stdout: a?.stdout ?? "", code: a?.code ?? 1 });
  };
  return { exec, calls };
}

describe("readWorktreeSettings", () => {
  it("defaults isolation on, base ref empty, forge auto, auto-trust on", async () => {
    const s = await readWorktreeSettings(memVault());
    expect(s).toEqual({ isolation: true, baseRef: "", prForge: "auto", autoTrust: true });
  });

  it("reads explicit values from the settings record", async () => {
    const vault = memVault({
      settings: {
        app: {
          worktreeIsolation: false,
          worktreeBaseRef: "origin/dev",
          prForge: "glab",
          worktreeAutoTrust: false,
        },
      },
    });
    const s = await readWorktreeSettings(vault);
    expect(s).toEqual({ isolation: false, baseRef: "origin/dev", prForge: "glab", autoTrust: false });
  });
});

describe("isolationEnabled", () => {
  const proj = (worktreeIsolation?: boolean): Project => ({
    id: "p1",
    name: "P",
    source: { kind: "local", path: "/tmp/p" },
    ...(worktreeIsolation === undefined ? {} : { worktreeIsolation }),
  });
  it("project override beats the global setting", () => {
    expect(isolationEnabled(true, proj(false))).toBe(false);
    expect(isolationEnabled(false, proj(true))).toBe(true);
  });
  it("inherits the global when the project has no override", () => {
    expect(isolationEnabled(true, proj())).toBe(true);
    expect(isolationEnabled(false, proj())).toBe(false);
    expect(isolationEnabled(true, null)).toBe(true);
  });
});

describe("worktreesRoot / isOrdenWorktree", () => {
  it("roots worktrees beside the vault", () => {
    expect(worktreesRoot("/home/u/.orden/vault")).toBe("/home/u/.orden/worktrees");
  });
  it("recognizes only paths under the worktrees root", () => {
    expect(isOrdenWorktree("/home/u/.orden/worktrees/p/s", "/home/u/.orden/vault")).toBe(true);
    expect(isOrdenWorktree("/home/u/projects/orden", "/home/u/.orden/vault")).toBe(false);
  });
});

describe("slugify", () => {
  it("lowercases and dashes non-alphanumerics", () => {
    expect(slugify("Fix the /repo-file route!!")).toBe("fix-the-repo-file-route");
  });
  it("truncates to 40 chars without a trailing dash", () => {
    const s = slugify("a".repeat(39) + " bcd");
    expect(s.length).toBeLessThanOrEqual(40);
    expect(s.endsWith("-")).toBe(false);
  });
  it("empty input gives an empty slug", () => {
    expect(slugify("  !! ")).toBe("");
  });
});

describe("defaultBaseRef", () => {
  it("uses origin/HEAD when set", async () => {
    const { exec } = fakeGit({ "symbolic-ref": { stdout: "origin/main\n", code: 0 } });
    expect(await defaultBaseRef("/repo", exec)).toBe("origin/main");
  });
  it("falls back to HEAD when origin/HEAD is unset", async () => {
    const { exec } = fakeGit({ "symbolic-ref": { code: 1 } });
    expect(await defaultBaseRef("/repo", exec)).toBe("HEAD");
  });
});

describe("pickBranch", () => {
  it("uses orden/<slug> when the branch is free", async () => {
    const { exec } = fakeGit({ "rev-parse": { code: 1 } }); // verify fails = free
    expect(await pickBranch("/repo", "Fix the thing", "sess_1", exec)).toBe("orden/fix-the-thing");
  });
  it("suffixes when the branch is taken", async () => {
    let n = 0;
    const exec: GitExec = (_cwd, args) => {
      if (args[0] === "rev-parse") {
        n += 1;
        return Promise.resolve({ stdout: "", code: n === 1 ? 0 : 1 }); // first taken
      }
      return Promise.resolve({ stdout: "", code: 1 });
    };
    expect(await pickBranch("/repo", "Fix the thing", "sess_1", exec)).toBe("orden/fix-the-thing-2");
  });
  it("falls back to the session id for an empty slug", async () => {
    const { exec } = fakeGit({ "rev-parse": { code: 1 } });
    expect(await pickBranch("/repo", undefined, "sess_9", exec)).toBe("orden/sess_9");
  });
});

describe("ensureSessionWorktree", () => {
  const base = () => mkdtempSync(join(tmpdir(), "orden-wt-"));

  it("reuses an existing workdir without any git calls", async () => {
    const dir = base();
    const existing = join(dir, "existing");
    mkdirSync(existing);
    const { exec, calls } = fakeGit({});
    const r = await ensureSessionWorktree(
      {
        repo: "/repo", vaultRoot: join(dir, "vault"), projectId: "p1", sessionId: "s1",
        existingWorkdir: existing, baseRefSetting: "",
      },
      exec,
    );
    expect(r).toEqual({ workdir: existing });
    expect(calls.length).toBe(0);
  });

  it("returns null for a non-git project dir", async () => {
    const dir = base();
    const exec: GitExec = (_cwd, args) =>
      Promise.resolve(
        args[0] === "rev-parse" && args.includes("--is-inside-work-tree")
          ? { stdout: "", code: 1 }
          : { stdout: "", code: 1 },
      );
    const r = await ensureSessionWorktree(
      { repo: join(dir, "norepo"), vaultRoot: join(dir, "vault"), projectId: "p1", sessionId: "s1", baseRefSetting: "" },
      exec,
    );
    expect(r).toBeNull();
  });

  it("creates the worktree with branch + base and returns both", async () => {
    const dir = base();
    const vaultRoot = join(dir, "vault");
    const calls: string[][] = [];
    const exec: GitExec = (cwd, args) => {
      calls.push([cwd, ...args]);
      if (args.includes("--is-inside-work-tree")) return Promise.resolve({ stdout: "true\n", code: 0 });
      if (args[0] === "rev-parse") return Promise.resolve({ stdout: "", code: 1 }); // branch free
      if (args[0] === "symbolic-ref") return Promise.resolve({ stdout: "origin/main\n", code: 0 });
      if (args[0] === "worktree") return Promise.resolve({ stdout: "", code: 0 });
      return Promise.resolve({ stdout: "", code: 1 });
    };
    const r = await ensureSessionWorktree(
      { repo: "/repo", vaultRoot, projectId: "p1", sessionId: "s1", title: "Fix It", baseRefSetting: "" },
      exec,
    );
    const expected = join(worktreesRoot(vaultRoot), "p1", "s1");
    expect(r).toEqual({ workdir: expected, branch: "orden/fix-it" });
    const wt = calls.find((c) => c[1] === "worktree");
    expect(wt).toEqual(["/repo", "worktree", "add", expected, "-b", "orden/fix-it", "origin/main"]);
  });

  it("honors an explicit base ref setting (no default-branch lookup)", async () => {
    const dir = base();
    const calls: string[][] = [];
    const exec: GitExec = (cwd, args) => {
      calls.push([cwd, ...args]);
      if (args.includes("--is-inside-work-tree")) return Promise.resolve({ stdout: "true\n", code: 0 });
      if (args[0] === "rev-parse") return Promise.resolve({ stdout: "", code: 1 });
      if (args[0] === "worktree") return Promise.resolve({ stdout: "", code: 0 });
      return Promise.resolve({ stdout: "", code: 1 });
    };
    const r = await ensureSessionWorktree(
      { repo: "/repo", vaultRoot: join(dir, "v"), projectId: "p", sessionId: "s", title: "x", baseRefSetting: "origin/dev" },
      exec,
    );
    expect(r?.branch).toBe("orden/x");
    expect(calls.some((c) => c[1] === "symbolic-ref")).toBe(false);
    expect(calls.find((c) => c[1] === "worktree")?.at(-1)).toBe("origin/dev");
  });

  it("falls back to the shared checkout (null) and warns loudly when worktree add fails", async () => {
    const dir = base();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const exec: GitExec = (_cwd, args) => {
      if (args.includes("--is-inside-work-tree")) return Promise.resolve({ stdout: "true\n", code: 0 });
      if (args[0] === "worktree") return Promise.resolve({ stdout: "", code: 128 });
      return Promise.resolve({ stdout: "", code: 1 });
    };
    try {
      const r = await ensureSessionWorktree(
        { repo: "/repo", vaultRoot: join(dir, "v"), projectId: "p", sessionId: "s", baseRefSetting: "" },
        exec,
      );
      expect(r).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toContain("worktree add failed");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("isGitRepo", () => {
  it("true only on a work-tree answer", async () => {
    const yes: GitExec = () => Promise.resolve({ stdout: "true\n", code: 0 });
    const no: GitExec = () => Promise.resolve({ stdout: "", code: 128 });
    expect(await isGitRepo("/x", yes)).toBe(true);
    expect(await isGitRepo("/x", no)).toBe(false);
  });
});
