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

  test("keeps the worktree when the branch is not pushed", async () => {
    for (const state of [undefined, "dirty", "no-remote", "push-failed"]) {
      const { host, gitCalls, exec } = setup(state);
      await reapCompletedCard(host, "c1", new Set(), { exec });
      expect(gitCalls).toEqual([]);
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
});
