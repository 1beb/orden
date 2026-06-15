# Worktree Pinning Fix Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Stop orden agents from running in (and dirtying) the shared `main` checkout when their session is supposed to be isolated in a git worktree.

**Architecture:** A session's working directory is fixed by tmux at session-create time (`tmux new-session -A -c <cwd>` ignores `-c` on reattach). If the first tmux create happens before the session's worktree exists — or while isolation is off, or after a silent `ensureSessionWorktree` failure — the agent is pinned to `main` forever, even though the session record later records a `workdir`. We close this three ways: (1) **detect and relocate** a mis-pinned session on attach by killing its stale tmux session so it is recreated in the correct cwd; (2) **never silently fall back to main** — log every fallback loudly; (3) a one-shot **operational sweep** to relocate the sessions already pinned.

**Tech Stack:** TypeScript, Node, `node-pty` + tmux, vitest. All host-side (`apps/host`).

**Background reading:** `apps/host/src/terminal.ts` (`resolveSessionCwd`, `handle`, `launchDetached`, `killSessionTmux`), `apps/host/src/worktrees.ts` (`ensureSessionWorktree`), design doc `docs/plans/2026-06-10-session-worktree-isolation-design.md`.

---

## Evidence this is real (do not re-investigate; verify after)

- `tmux list-sessions -F '#{session_name} #{session_path}'` shows sessions with `path=/home/b/projects/orden` (main) whose vault record `workdir` points at a worktree (proven for `sess_mqepqy0w_1`).
- `tmux new-session -A -c <dir>` only honors `-c` on **create**; reattach never moves an existing session. This is the pin.
- `ensureSessionWorktree` (`worktrees.ts:145`) returns `null` on failure with **no log**; `resolveSessionCwd` `return path` fallbacks are silent. The host log has zero worktree lines.

---

### Task 1: A pure helper to read a tmux session's working directory

**Files:**
- Modify: `apps/host/src/terminal.ts`
- Test: `apps/host/test/terminal.test.ts`

**Step 1: Write the failing test**

```ts
import { tmuxSessionPath } from "../src/terminal";

it("returns the session_path tmux reports, trimmed", async () => {
  const fakeExec = async (_cmd: string, _args: string[]) =>
    ({ stdout: "/home/b/projects/orden\n", stderr: "" });
  expect(await tmuxSessionPath("orden-sess_x", fakeExec)).toBe("/home/b/projects/orden");
});

it("returns null when the session does not exist (tmux exits non-zero)", async () => {
  const fakeExec = async () => { throw new Error("no server"); };
  expect(await tmuxSessionPath("orden-missing", fakeExec)).toBeNull();
});
```

**Step 2: Run it, expect FAIL** (`tmuxSessionPath` not exported)

Run: `pnpm --filter @orden/host exec vitest run apps/host/test/terminal.test.ts -t "session_path"`
Expected: FAIL "tmuxSessionPath is not a function".

**Step 3: Minimal implementation** — add near `tmuxNameFor` in `terminal.ts`:

```ts
// The cwd a live tmux session was CREATED with. tmux fixes this at create time;
// `new-session -A -c` cannot change it on reattach — so a mismatch against the
// resolved worktree means the agent is pinned to the wrong directory.
export async function tmuxSessionPath(
  name: string,
  run: (cmd: string, args: string[]) => Promise<{ stdout: string }> = exec,
): Promise<string | null> {
  try {
    const r = await run("tmux", ["display-message", "-p", "-t", name, "#{session_path}"]);
    const p = r.stdout.trim();
    return p || null;
  } catch {
    return null; // no session / no server
  }
}
```

**Step 4: Run, expect PASS.**

**Step 5: Commit** — `git add apps/host/src/terminal.ts apps/host/test/terminal.test.ts && git commit -m "host: read a tmux session's working dir (tmuxSessionPath)"`

---

### Task 2: A pure decision: should we relocate the session?

**Files:**
- Modify: `apps/host/src/terminal.ts`
- Test: `apps/host/test/terminal.test.ts`

**Step 1: Write the failing test**

```ts
import { shouldRelocateSession } from "../src/terminal";

it("relocates when a live session sits in a dir other than the resolved cwd", () => {
  expect(shouldRelocateSession("/home/b/projects/orden", "/home/b/.orden/worktrees/p/s")).toBe(true);
});
it("does not relocate when paths match", () => {
  expect(shouldRelocateSession("/wt/s", "/wt/s")).toBe(false);
});
it("does not relocate when there is no live session (null path)", () => {
  expect(shouldRelocateSession(null, "/wt/s")).toBe(false);
});
```

**Step 2: Run, expect FAIL.**

**Step 3: Minimal implementation:**

```ts
// Relocate only when a session is ALREADY live in a different directory than the
// one we resolved for it. No live session (null) => normal first create, nothing
// to relocate. Equal paths => already correct.
export function shouldRelocateSession(livePath: string | null, resolvedCwd: string): boolean {
  return livePath !== null && livePath !== resolvedCwd;
}
```

**Step 4: Run, expect PASS.**

**Step 5: Commit** — `git commit -m "host: decide when a live session must be relocated"`

---

### Task 3: Relocate a mis-pinned session on attach

**Files:**
- Modify: `apps/host/src/terminal.ts` (`handle`, around lines 660-687)
- Test: `apps/host/test/terminal.test.ts`

**Context:** In `handle`, after `cwd` is resolved and before the `ptySpawn("tmux", ["new-session", "-A", ...])`, kill any existing tmux session whose path differs from `cwd`. `killSessionTmux` already does a thorough kill; after it, `new-session -A` recreates the session in the correct `cwd`. The agent's conversation is preserved (claude resumes via `--resume`/persisted `conversationId`; the relaunch path in `buildCommand` already handles this).

**Step 1: Write a failing test** that exercises the relocate decision wiring. Because `handle` is socket-driven and hard to unit-test, extract the relocate step into a small testable async function:

```ts
import { relocateIfPinned } from "../src/terminal";

it("kills the session when its live path differs from the resolved cwd", async () => {
  const killed: string[] = [];
  await relocateIfPinned("orden-s", "/wt/s", {
    sessionPath: async () => "/home/b/projects/orden",
    kill: async (name) => { killed.push(name); },
  });
  expect(killed).toEqual(["orden-s"]);
});

it("does nothing when the live path already matches", async () => {
  const killed: string[] = [];
  await relocateIfPinned("orden-s", "/wt/s", {
    sessionPath: async () => "/wt/s",
    kill: async (name) => { killed.push(name); },
  });
  expect(killed).toEqual([]);
});
```

**Step 2: Run, expect FAIL.**

**Step 3: Implement** `relocateIfPinned` and call it in `handle`:

```ts
export async function relocateIfPinned(
  tmuxName: string,
  resolvedCwd: string,
  ops: {
    sessionPath?: (name: string) => Promise<string | null>;
    kill?: (name: string) => Promise<void>;
  } = {},
): Promise<void> {
  const sessionPath = ops.sessionPath ?? ((n: string) => tmuxSessionPath(n));
  const kill = ops.kill ?? ((n: string) => killSessionTmux(n));
  const live = await sessionPath(tmuxName);
  if (shouldRelocateSession(live, resolvedCwd)) {
    // eslint-disable-next-line no-console
    console.warn(
      `orden: relocating session ${tmuxName} from ${live} to ${resolvedCwd} (was pinned to the wrong checkout)`,
    );
    await kill(tmuxName);
  }
}
```

In `handle`, immediately after `const cwd = await resolveSessionCwd(...)` and the `mkdirSync` recovery block, before computing `preLaunch`/`cmd`, add:

```ts
await relocateIfPinned(tmuxNameFor(sessionId), cwd);
```

**Step 4: Run the full host suite** — `pnpm --filter @orden/host test`
Expected: PASS, no regressions (esp. `terminal.test.ts`, `terminalScratch.test.ts`).

**Step 5: Commit** — `git commit -m "host: relocate a session pinned to the wrong checkout on attach"`

---

### Task 4: Never silently fall back to main — log every fallback

**Files:**
- Modify: `apps/host/src/worktrees.ts` (`ensureSessionWorktree`, lines 144-145)
- Modify: `apps/host/src/terminal.ts` (`resolveSessionCwd`, the `return path` fallbacks at the isolation branch ~lines 292-307)
- Test: `apps/host/test/worktrees.test.ts`

**Step 1: Write the failing test**

```ts
it("warns when `git worktree add` fails (silent fallback regression guard)", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const exec: GitExec = async (_cwd, args) => {
    if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") return { stdout: "true", code: 0 };
    if (args.includes("worktree")) return { stdout: "", code: 1 }; // add fails
    return { stdout: "", code: 0 };
  };
  const out = await ensureSessionWorktree(
    { repo: "/repo", vaultRoot: "/v", projectId: "p", sessionId: "s", baseRefSetting: "HEAD" },
    exec,
  );
  expect(out).toBeNull();
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("worktree add failed"));
  warn.mockRestore();
});
```

**Step 2: Run, expect FAIL** (no warn today).

**Step 3: Implement** — in `ensureSessionWorktree`, replace the silent `if (r.code !== 0) return null;`:

```ts
  const r = await exec(input.repo, ["worktree", "add", workdir, "-b", branch, base]);
  if (r.code !== 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `orden: worktree add failed for session ${input.sessionId} (repo ${input.repo}, branch ${branch}); ` +
        `falling back to the SHARED checkout`,
    );
    return null;
  }
```

And in `resolveSessionCwd`, the isolation-on-but-fell-back return (after `if (!wt) return path;`) is covered by the above; additionally warn when isolation is on but `vaultRoot` is missing (`if (!vaultRoot)` branch).

**Step 4: Run** — `pnpm --filter @orden/host exec vitest run apps/host/test/worktrees.test.ts`
Expected: PASS.

**Step 5: Commit** — `git commit -m "host: log loudly on every worktree->shared-checkout fallback"`

---

### Task 5: Operational sweep — relocate the sessions already pinned

**Not code — an operational step. Do this once after Tasks 1-4 are merged + the host is rebuilt/restarted.**

The 5 live sessions pinned to `main` (created 2026-06-15 00:28-01:52: `sess_mqepqy0w_1`, `sess_mqeshv4g_2`, `sess_mqesi7fe_5`, `sess_mqesih2k_6`, `sess_mqesr2py_1`) will NOT relocate on their own — relocation triggers on the next attach. Two options:

1. **Reopen each in the browser** once the fix is live — `relocateIfPinned` kills the main-pinned tmux session and recreates it in its worktree on reattach. The agent resumes via `--resume`. Verify with `tmux list-sessions -F '#{session_name} #{session_path}'` (all should show worktree paths).
2. **Kill them now** if their in-flight work is not worth keeping: `tmux kill-session -t orden-<sessionId>` for each. They relaunch correctly when reopened.

Before either, confirm `main` is clean (`git -C /home/b/projects/orden status --porcelain`). Loose work already rescued onto branch `orden/rescue-dirty-main-20260615`.

**Acceptance:** `tmux list-sessions` shows no orden session with `session_path=/home/b/projects/orden`, and `git -C /home/b/projects/orden status` stays clean while agents work.

---

### Task 6: Full verification

**Step 1:** `pnpm -r typecheck` — expect clean.
**Step 2:** `pnpm --filter @orden/host test` — expect all pass.
**Step 3:** Manual: with isolation on, spawn a fresh session, confirm `tmux display-message -p -t orden-<id> '#{session_path}'` is the worktree, edit a file, confirm `main` stays clean.
**Step 4:** Regression: stop the host before its worktree exists for a session, reopen — confirm the relocate warning fires and the session lands in the worktree, not main.

---

## Out of scope (note, don't build here)

- Removing the *incentive* to visit main (host serving dist from the main checkout). A deeper fix is per-session dist/port so an agent never needs main to see its change. Track separately.
- Path-scoping the destructive-git PreToolUse hook so a worktree session can't run destructive git against main via `-C`/`cd`. Defense-in-depth, separate change.
