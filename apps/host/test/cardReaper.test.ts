import { describe, test, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Host } from "@orden/host-api";
import { reapCompletedCard } from "../src/cardReaper";
import { worktreesRoot } from "../src/worktrees";

// Minimal host: in-memory cards/sessions/projects stores + a kill spy. The
// reaper touches host.vault.get, host.sessions.kill, and (for the worktree
// cleanup pass) host.capabilities().vaultRoot.
function makeHost(vaultRoot?: string) {
  const cards = new Map<string, unknown>();
  const sessions = new Map<string, unknown>();
  const projects = new Map<string, unknown>();
  const killed: string[] = [];
  const host = {
    vault: {
      async get<T>(ns: string, key: string): Promise<T | null> {
        if (ns === "cards") return (cards.get(key) as T) ?? null;
        if (ns === "sessions") return (sessions.get(key) as T) ?? null;
        if (ns === "projects") return (projects.get(key) as T) ?? null;
        return null;
      },
      async set(ns: string, key: string, value: unknown): Promise<void> {
        if (ns === "cards") cards.set(key, value);
        else if (ns === "sessions") sessions.set(key, value);
        else if (ns === "projects") projects.set(key, value);
      },
    },
    sessions: {
      async kill(id: string): Promise<void> {
        killed.push(id);
      },
    },
    capabilities: () => ({ vaultRoot }),
  } as unknown as Host;
  return { host, cards, sessions, projects, killed };
}

describe("reapCompletedCard", () => {
  let reaped: Set<string>;
  beforeEach(() => {
    reaped = new Set();
  });

  test("kills every linked session when a card is complete", async () => {
    const { host, cards, killed } = makeHost();
    cards.set("c1", { id: "c1", state: "complete", sessionIds: ["s1", "s2"] });
    await reapCompletedCard(host, "c1", reaped);
    expect(killed).toEqual(["s1", "s2"]);
  });

  test("ignores cards that aren't complete", async () => {
    const { host, cards, killed } = makeHost();
    cards.set("c1", { id: "c1", state: "in-progress", sessionIds: ["s1"] });
    await reapCompletedCard(host, "c1", reaped);
    expect(killed).toEqual([]);
  });

  test("tolerates the legacy single-sessionId shape", async () => {
    const { host, cards, killed } = makeHost();
    cards.set("c1", { id: "c1", state: "complete", sessionId: "s9" });
    await reapCompletedCard(host, "c1", reaped);
    expect(killed).toEqual(["s9"]);
  });

  test("reaps a completion only once", async () => {
    const { host, cards, killed } = makeHost();
    cards.set("c1", { id: "c1", state: "complete", sessionIds: ["s1"] });
    await reapCompletedCard(host, "c1", reaped);
    await reapCompletedCard(host, "c1", reaped); // re-write to an already-complete card
    expect(killed).toEqual(["s1"]);
  });

  test("re-reaps after a card leaves and re-enters complete", async () => {
    const { host, cards, killed } = makeHost();
    cards.set("c1", { id: "c1", state: "complete", sessionIds: ["s1"] });
    await reapCompletedCard(host, "c1", reaped);
    cards.set("c1", { id: "c1", state: "in-progress", sessionIds: ["s1"] });
    await reapCompletedCard(host, "c1", reaped); // leaving Done clears the guard
    cards.set("c1", { id: "c1", state: "complete", sessionIds: ["s1"] });
    await reapCompletedCard(host, "c1", reaped);
    expect(killed).toEqual(["s1", "s1"]);
  });

  test("is a no-op for a missing card", async () => {
    const { host, killed } = makeHost();
    await reapCompletedCard(host, "nope", reaped);
    expect(killed).toEqual([]);
  });
});

describe("reapCompletedCard worktree cleanup", () => {
  // A real on-disk worktree dir under a real vault root, so the existsSync and
  // isOrdenWorktree guards pass; git calls are scripted.
  function setup(publishState?: string) {
    const base = mkdtempSync(join(tmpdir(), "orden-reap-"));
    const vaultRoot = join(base, "vault");
    const repo = join(base, "repo");
    mkdirSync(repo);
    const workdir = join(worktreesRoot(vaultRoot), "p1", "s1");
    mkdirSync(workdir, { recursive: true });
    const { host, cards, sessions, projects, killed } = makeHost(vaultRoot);
    cards.set("c1", { id: "c1", state: "complete", sessionIds: ["s1"], ...(publishState ? { publishState } : {}) });
    sessions.set("s1", { id: "s1", projectId: "p1", workdir, branch: "orden/x" });
    projects.set("p1", { id: "p1", name: "P", source: { kind: "local", path: repo } });
    const gitCalls: string[][] = [];
    const exec = (cwd: string, args: string[]) => {
      gitCalls.push([cwd, ...args]);
      // merge-base --is-ancestor exits 0 = merged, 1 = not merged. Default: not
      // merged, so tests that don't override stay "keep the worktree" unless they
      // script a local-merge scenario.
      if (args[0] === "merge-base") return Promise.resolve({ stdout: "", code: 1 });
      return Promise.resolve({ stdout: "", code: 0 });
    };
    return { host, killed, gitCalls, exec, repo, workdir };
  }

  test("removes the worktree once the branch is pushed", async () => {
    const { host, gitCalls, exec, repo, workdir } = setup("pushed");
    await reapCompletedCard(host, "c1", new Set(), { exec });
    expect(gitCalls).toEqual([
      [repo, "worktree", "remove", workdir],
      [repo, "worktree", "prune"],
    ]);
  });

  test("removes the worktree when the coordinator merged the card (no publishState)", async () => {
    const { host, gitCalls, exec, repo, workdir } = setup(undefined);
    const card = (await host.vault.get<Record<string, unknown>>("cards", "c1"))!;
    card.mergeStatus = "merged";
    await reapCompletedCard(host, "c1", new Set(), { exec });
    expect(gitCalls).toEqual([
      [repo, "worktree", "remove", workdir],
      [repo, "worktree", "prune"],
    ]);
  });

  test("keeps the worktree when the branch is not pushed (and not locally merged, not stale)", async () => {
    for (const state of [undefined, "dirty", "no-remote", "push-failed"]) {
      const { host, gitCalls, exec } = setup(state);
      await reapCompletedCard(host, "c1", new Set(), { exec });
      // The reaper probes merge-base to check for a local merge, but must NOT
      // remove the worktree (unpushed, unmerged, fresh).
      expect(gitCalls.some((c) => c[1] === "worktree" && c[2] === "remove")).toBe(false);
    }
  });

  test("cleanup runs even when the kill pass was already memoized (late publish stamp)", async () => {
    const { host, killed, gitCalls, exec } = setup("pr-opened");
    const memo = new Set(["c1"]); // completion already reaped earlier
    await reapCompletedCard(host, "c1", memo, { exec });
    expect(killed).toEqual([]); // no re-kill
    expect(gitCalls.some((c) => c[1] === "worktree" && c[2] === "remove")).toBe(true);
  });

  test("skips a worktree dir that is already gone", async () => {
    const { host, gitCalls, exec, workdir } = setup("pushed");
    // Point the session at a path that doesn't exist.
    void workdir;
    const ses = (await host.vault.get<Record<string, unknown>>("sessions", "s1"))!;
    ses.workdir = workdir + "-gone";
    await reapCompletedCard(host, "c1", new Set(), { exec });
    expect(gitCalls).toEqual([]);
  });

  // Fix D: local-merge reap. The user merged the branch into the main checkout
  // manually (without pushing or using the coordinator), so neither publishState
  // nor mergeStatus reflects it. The ancestor check catches this.
  test("reaps when the branch is locally merged (ancestor of main checkout HEAD)", async () => {
    const { host, gitCalls, exec, repo, workdir } = setup(undefined);
    // merge-base --is-ancestor returns 0 = branch IS an ancestor of HEAD (merged)
    const mergeExec = (cwd: string, args: string[]) => {
      gitCalls.push([cwd, ...args]);
      if (args[0] === "merge-base") return Promise.resolve({ stdout: "", code: 0 });
      return Promise.resolve({ stdout: "", code: 0 });
    };
    await reapCompletedCard(host, "c1", new Set(), { exec: mergeExec });
    expect(gitCalls).toContainEqual([repo, "merge-base", "--is-ancestor", "orden/x", "HEAD"]);
    expect(gitCalls).toEqual([
      [repo, "merge-base", "--is-ancestor", "orden/x", "HEAD"],
      [repo, "worktree", "remove", workdir],
      [repo, "worktree", "prune"],
    ]);
  });

  test("keeps an unpushed, unmerged, fresh worktree (no local merge, not stale)", async () => {
    // The default setup exec returns code 1 for merge-base (not merged).
    // No completedAt → not stale.
    const { host, gitCalls, exec } = setup(undefined);
    await reapCompletedCard(host, "c1", new Set(), { exec });
    expect(gitCalls.some((c) => c[1] === "worktree" && c[2] === "remove")).toBe(false);
    expect(gitCalls.some((c) => c[1] === "merge-base")).toBe(true); // probed but not merged
  });

  test("reaps a stale unpushed worktree (completed > 14 days ago)", async () => {
    const { host, gitCalls, exec, repo, workdir } = setup(undefined);
    // Stamp a completion time 15 days ago.
    const card = (await host.vault.get<Record<string, unknown>>("cards", "c1"))!;
    card.completedAt = Date.now() - 15 * 24 * 60 * 60 * 1000;
    await host.vault.set("cards", "c1", card);
    await reapCompletedCard(host, "c1", new Set(), { exec });
    // merge-base probe ran (returned not-merged), but staleness reaped it anyway.
    expect(gitCalls.some((c) => c[1] === "merge-base")).toBe(true);
    expect(gitCalls).toContainEqual([repo, "worktree", "remove", workdir]);
  });

  test("does NOT reap a recently-completed unpushed worktree (within staleness window)", async () => {
    const { host, gitCalls, exec } = setup(undefined);
    const card = (await host.vault.get<Record<string, unknown>>("cards", "c1"))!;
    card.completedAt = Date.now() - 3 * 24 * 60 * 60 * 1000; // 3 days ago
    await host.vault.set("cards", "c1", card);
    await reapCompletedCard(host, "c1", new Set(), { exec });
    expect(gitCalls.some((c) => c[1] === "worktree" && c[2] === "remove")).toBe(false);
  });

  test("local-merge check runs against the project's main checkout, not the worktree", async () => {
    const { host, gitCalls, repo } = setup(undefined);
    const mergeExec = (cwd: string, args: string[]) => {
      gitCalls.push([cwd, ...args]);
      if (args[0] === "merge-base") return Promise.resolve({ stdout: "", code: 0 });
      return Promise.resolve({ stdout: "", code: 0 });
    };
    await reapCompletedCard(host, "c1", new Set(), { exec: mergeExec });
    // The merge-base call must target the project repo path, not the worktree.
    const mb = gitCalls.find((c) => c[1] === "merge-base");
    expect(mb).toBeDefined();
    expect(mb![0]).toBe(repo);
  });
});
