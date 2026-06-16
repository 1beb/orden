# Merge Coordinator Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** A host-side reactor that autonomously orders, conflict-resolves, and integrates completed agent branches onto trunk, using each session's intent (planDoc/description) — silent on everything verifiable, escalating only genuine intent collisions or unverifiable resolutions.

**Architecture:** A fifth `host.onChange` reactor on the `cards` namespace (peer to launch/reap/publish/journal in `serve.ts`). Completed cards enqueue into a new `merge-queue` vault namespace; the coordinator drains them serially onto one host-managed `orden/integration` worktree (Not-Rocket-Science Rule / Bors — a single stationary target). `git merge-tree` is a cheap preview; real apply/resolve/gate run in the integration worktree. A per-project `integrationMode` (`fast` = merge local main + rebuild; `measured` = push + PR) is a one-line switch at the end of an otherwise-shared pipeline. Conflicts spawn an ephemeral resolver agent given every contributing branch's intent; its outcome classifies the conflict (reconciled / intent-collision / unverifiable).

**Tech Stack:** TypeScript, Node, vitest. Git plumbing (`merge-tree --write-tree --name-only`, ≥2.38). Injectable `GitExec` / `ForgeRunner` (already in `worktrees.ts` / `publishSession.ts`); a new injectable `GateRunner` and `ResolverRunner`. Vault KV + change feed. Web: ProseMirror/vanilla TS, the `settingsBindings` / `viewRegistry` seams.

Design doc: `docs/plans/2026-06-15-merge-coordinator-design.md` (read it first).

---

## Conventions for every task

- TDD: write the failing test, run it red, implement minimally, run it green, commit.
- Test runner: `pnpm --filter @orden/host exec vitest run <file>` (single file) or `-t "<name>"` (single test).
- After a phase: `pnpm -r typecheck` must be green before moving on.
- Commit messages: short, imperative, no Claude attribution (`feat:`/`test:`/`refactor:`).
- Inject all git/process/agent calls — no test spawns a real git, agent, or build.

---

## Phase A — Integration-branch git machinery (`apps/host/src/integrationBranch.ts`)

Pure, fully unit-testable with an injected `GitExec`. This is the only genuinely new git logic in the repo. No reactor, no vault, no agents yet.

### Task A1: Module skeleton + `ensureIntegrationWorktree`

**Files:**
- Create: `apps/host/src/integrationBranch.ts`
- Test: `apps/host/test/integrationBranch.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { ensureIntegrationWorktree } from "../src/integrationBranch";
import type { GitExec } from "../src/worktrees";

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
  it("creates an orden/integration worktree off the base ref and returns its path + tip", async () => {
    const { exec, calls } = recordingExec({
      "rev-parse HEAD": { stdout: "abc123\n" },
    });
    const res = await ensureIntegrationWorktree(
      { repo: "/repo", integrationRoot: "/wt/_integration", base: "main" },
      exec,
    );
    expect(res).toEqual({ workdir: "/wt/_integration", branch: "orden/integration", tip: "abc123" });
    // fresh create: add a worktree on a new branch off base
    expect(calls.some((a) => a[0] === "worktree" && a.includes("orden/integration"))).toBe(true);
  });
});
```

**Step 2: Run it red** — `pnpm --filter @orden/host exec vitest run apps/host/test/integrationBranch.test.ts` → FAIL (module not found).

**Step 3: Implement minimally**

```ts
import { existsSync } from "node:fs";
import { defaultGitExec, type GitExec } from "./worktrees";

export const INTEGRATION_BRANCH = "orden/integration";

export interface IntegrationInput {
  repo: string;            // the project's main checkout
  integrationRoot: string; // ~/.orden/worktrees/<projectId>/_integration
  base: string;            // ref to (re)build integration from, e.g. "main"
}

export interface IntegrationHandle {
  workdir: string;
  branch: string;
  tip: string;
}

// Create (or reuse+reset) the host-managed integration worktree off `base`.
export async function ensureIntegrationWorktree(
  input: IntegrationInput,
  exec: GitExec = defaultGitExec,
): Promise<IntegrationHandle> {
  const { repo, integrationRoot, base } = input;
  if (!existsSync(integrationRoot)) {
    await exec(repo, ["worktree", "add", "-B", INTEGRATION_BRANCH, integrationRoot, base]);
  } else {
    // reuse: hard-sync the branch back to base so each drain starts clean
    await exec(integrationRoot, ["reset", "--hard", base]);
    await exec(integrationRoot, ["clean", "-fdq"]);
  }
  const tip = (await exec(integrationRoot, ["rev-parse", "HEAD"])).stdout.trim();
  return { workdir: integrationRoot, branch: INTEGRATION_BRANCH, tip };
}
```

**Step 4: Run green.** **Step 5: Commit** `feat: integration worktree scaffold`.

> Note: `reset --hard`/`clean -fdq` here are on the host's OWN `_integration` worktree, never a session worktree — outside the destructive-git guard's scope (the guard targets agent shells).

### Task A2: `previewMerge` — cheap conflict pre-check

**Step 1: failing test** (add to same test file):

```ts
import { previewMerge } from "../src/integrationBranch";

describe("previewMerge", () => {
  it("reports clean when merge-tree exits 0", async () => {
    const { exec } = recordingExec({ "merge-tree": { stdout: "treeoid\n", code: 0 } });
    expect(await previewMerge("/wt", "orden/integration", "orden/feat-a", exec))
      .toEqual({ clean: true, conflictFiles: [] });
  });
  it("lists conflicted files when merge-tree exits nonzero", async () => {
    const { exec } = recordingExec({
      "merge-tree": { stdout: "treeoid\n\napps/web/src/main.ts\napps/host/src/terminal.ts\n", code: 1 },
    });
    expect(await previewMerge("/wt", "orden/integration", "orden/feat-a", exec))
      .toEqual({ clean: false, conflictFiles: ["apps/web/src/main.ts", "apps/host/src/terminal.ts"] });
  });
});
```

**Step 3: implement**

```ts
export interface MergePreview { clean: boolean; conflictFiles: string[]; }

// `--name-only`: line 0 is the merged tree OID; on conflict (code != 0) the
// remaining non-empty lines are the conflicted paths. No working tree touched.
export async function previewMerge(
  cwd: string, into: string, incoming: string, exec: GitExec = defaultGitExec,
): Promise<MergePreview> {
  const { stdout, code } = await exec(cwd, ["merge-tree", "--write-tree", "--name-only", into, incoming]);
  if (code === 0) return { clean: true, conflictFiles: [] };
  const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  return { clean: false, conflictFiles: lines.slice(1) };
}
```

**Commit** `feat: merge-tree conflict preview`.

### Task A3: `applyClean` and `resetIntegration`

**Step 1: failing tests**

```ts
import { applyClean, resetIntegration } from "../src/integrationBranch";

it("applyClean merges incoming with --no-ff and returns the new tip", async () => {
  const { exec, calls } = recordingExec({ "rev-parse HEAD": { stdout: "newtip\n" } });
  const tip = await applyClean("/wt", "orden/feat-a", "merge A", exec);
  expect(tip).toBe("newtip");
  expect(calls.some((a) => a[0] === "merge" && a.includes("--no-ff"))).toBe(true);
});

it("resetIntegration aborts any in-progress merge then hard-resets to the prior tip", async () => {
  const { exec, calls } = recordingExec();
  await resetIntegration("/wt", "priortip", exec);
  expect(calls).toEqual([
    ["merge", "--abort"],
    ["reset", "--hard", "priortip"],
  ]);
});
```

**Step 3: implement**

```ts
export async function applyClean(
  cwd: string, incoming: string, message: string, exec: GitExec = defaultGitExec,
): Promise<string> {
  await exec(cwd, ["merge", "--no-ff", "--no-edit", "-m", message, incoming]);
  return (await exec(cwd, ["rev-parse", "HEAD"])).stdout.trim();
}

// merge --abort is best-effort (errors when no merge is in progress); the caller
// has already decided to discard. Then hard-reset to the last good tip.
export async function resetIntegration(
  cwd: string, priorTip: string, exec: GitExec = defaultGitExec,
): Promise<void> {
  await exec(cwd, ["merge", "--abort"]);
  await exec(cwd, ["reset", "--hard", priorTip]);
}
```

**Commit** `feat: clean apply + integration reset`.

### Task A4: `changedFiles` — map a branch to the files it touched

Used later to attribute conflict files to already-integrated sibling cards.

**Step 1: failing test**

```ts
import { changedFiles } from "../src/integrationBranch";
it("lists files a branch changed vs the base", async () => {
  const { exec } = recordingExec({ "diff --name-only": { stdout: "a.ts\nb.ts\n" } });
  expect(await changedFiles("/wt", "main", "orden/feat-a", exec)).toEqual(["a.ts", "b.ts"]);
});
```

**Step 3: implement**

```ts
export async function changedFiles(
  cwd: string, base: string, branch: string, exec: GitExec = defaultGitExec,
): Promise<string[]> {
  const { stdout } = await exec(cwd, ["diff", "--name-only", `${base}...${branch}`]);
  return stdout.split("\n").map((l) => l.trim()).filter(Boolean);
}
```

**Commit** `feat: changed-files attribution helper`.

### Task A5: `runGate` — the build/test verification seam

**Files:** same module. Define an injectable `GateRunner` so tests never run a real build.

**Step 1: failing test**

```ts
import { runGate, type GateRunner } from "../src/integrationBranch";
it("runGate returns green on a zero-exit runner", async () => {
  const runner: GateRunner = async () => ({ code: 0, output: "ok" });
  expect(await runGate("/wt", "pnpm -r test", runner)).toEqual({ green: true, output: "ok" });
});
it("runGate returns red with output on a nonzero runner", async () => {
  const runner: GateRunner = async () => ({ code: 1, output: "boom" });
  expect(await runGate("/wt", "pnpm -r test", runner)).toEqual({ green: false, output: "boom" });
});
```

**Step 3: implement**

```ts
export type GateRunner = (cwd: string, command: string) => Promise<{ code: number; output: string }>;

export const defaultGateRunner: GateRunner = async (cwd, command) => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  try {
    const { stdout, stderr } = await run("bash", ["-lc", command], { cwd, timeout: 15 * 60_000, maxBuffer: 64 * 1024 * 1024 });
    return { code: 0, output: `${stdout}\n${stderr}` };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof e.code === "number" ? e.code : 1, output: `${e.stdout ?? ""}\n${e.stderr ?? ""}` };
  }
};

export async function runGate(
  cwd: string, command: string, runner: GateRunner = defaultGateRunner,
): Promise<{ green: boolean; output: string }> {
  const { code, output } = await runner(cwd, command);
  return { green: code === 0, output };
}
```

**Commit** `feat: pluggable integration gate runner`. Then `pnpm -r typecheck`.

---

## Phase B — Data model + settings

### Task B1: Extend `Project` (host-api)

**Files:** Modify `packages/host-api/src/index.ts:64-74`.

**Step 1: failing test** — `packages/host-api/test/project.types.test.ts`:

```ts
import { expectTypeOf } from "vitest";
import type { Project } from "../src/index";
it("Project carries optional per-project integration overrides", () => {
  expectTypeOf<Project["integrationMode"]>().toEqualTypeOf<"fast" | "measured" | undefined>();
  expectTypeOf<Project["integrationVerify"]>().toEqualTypeOf<string | undefined>();
});
```

**Step 3: implement** — add to the `Project` interface:

```ts
  /** Per-project integration boundary. Absent = inherit the global default. */
  integrationMode?: "fast" | "measured";
  /** Per-project gate command. Absent = global default verify command. */
  integrationVerify?: string;
```

**Commit** `feat: per-project integration overrides on Project`.

### Task B2: Merge-queue + card record types

**Files:** Create `apps/host/src/mergeTypes.ts`; Test `apps/host/test/mergeTypes.test.ts`.

Define `MergeQueueEntry` and the card-field additions (cards are loose `[k: string]: unknown`, so this is a typed view used by the coordinator):

```ts
export type MergeStatus =
  | "queued" | "merging" | "merged" | "skipped" | "blocked-intent" | "blocked-unverifiable";

export interface IntegrationBlock {
  kind: "intent" | "unverifiable";
  question: string;            // goal-level, no diffs
  options?: string[];          // one chip per contributing card (intent only, >=2)
  otherCardIds?: string[];     // every colliding sibling (1..N)
  chosen?: string;             // the winning card id, written on resolve
}

export interface MergeQueueEntry {
  cardId: string;
  branch: string;
  enqueuedAt: number;          // = card.completedAt, FIFO key
  status: "queued" | "merging" | "merged" | "skipped" | "escalated";
  result?: "clean" | "resolved" | "intent-conflict" | "unverifiable";
  integrationTip?: string;
  error?: string;
}

export const MERGE_QUEUE_NS = "merge-queue";
```

Write a trivial test asserting the union members exist (a runtime const map) so the file is covered. **Commit** `feat: merge-queue + integration-block types`.

### Task B3: Settings defaults reader

**Files:** Modify `apps/host/src/worktrees.ts` `readWorktreeSettings` (or add `readIntegrationSettings` beside it). Test in `apps/host/test/worktrees.test.ts`.

Add resolution: `integrationMode` (default `"fast"`), `integrationVerify` (default `"pnpm -r typecheck && pnpm -r test"`). Per-project override beats global. Write a failing test that a project with `integrationMode: "measured"` overrides a global `fast`, and absent inherits. **Commit** `feat: integration settings resolution (project over global)`.

---

## Phase C — The coordinator (`apps/host/src/mergeCoordinator.ts`)

Unit-testable: inject the Phase-A functions, a fake vault, a `ResolverRunner` stub, and a `GateRunner`. No real agents/git/build.

### Task C1: Resolver seam + queue read

**Files:** Create `apps/host/src/mergeCoordinator.ts`; Test `apps/host/test/mergeCoordinator.test.ts`.

```ts
export interface ResolverInput {
  integrationWorkdir: string;
  incoming: { cardId: string; branch: string; planDoc?: string; description?: string };
  // every already-integrated sibling whose hunks the incoming branch collides with:
  contributors: Array<{ cardId: string; branch: string; planDoc?: string; description?: string }>;
  conflictFiles: string[];
}
export type ResolverOutcome =
  | { kind: "resolved" }                                  // committed a reconciliation in the worktree
  | { kind: "intent-conflict"; question: string; options: string[] }
  | { kind: "unverifiable"; question: string };
export type ResolverRunner = (input: ResolverInput) => Promise<ResolverOutcome>;
```

**Test:** a fake vault returns three `merge-queue` entries with `status:"queued"`; assert `readReadyQueue(vault)` returns them sorted by `enqueuedAt` ascending (FIFO). Implement `readReadyQueue`. **Commit** `feat: resolver seam + FIFO queue read`.

### Task C2: `enqueueOnComplete`

When a card is `complete` with a clean published branch, write a `merge-queue` entry (idempotent — skip if one exists). **Test:** completing card writes one entry; second call is a no-op. **Commit** `feat: enqueue completed cards for integration`.

### Task C3: The drain loop (core)

The heart. Inject `{ vault, git, gate, resolver, settings }`. Pseudocode the test asserts against, one behavior per test:

1. **All-clean path:** 3 queued branches, `previewMerge` clean for all → each `applyClean`'d in FIFO order, all marked `status:"merged"`, gate run once at end green → terminal step invoked. (Stub git/gate.)
2. **Conflict→resolved:** branch B conflicts; resolver returns `{kind:"resolved"}`; gate green → B marked merged with `result:"resolved"`.
3. **Conflict→intent:** resolver returns `{kind:"intent-conflict"}` → integration reset to tip-before-B; B's card → `blocked`, `mergeStatus:"blocked-intent"`, `integrationBlock` written with `otherCardIds` = contributors; queue continues to C.
4. **Gate red, unfixable:** after applying B (clean) the end-gate is red and a re-resolve can't fix → B reset+skipped, `blocked-unverifiable`. (Keep it simple: gate runs per-applied-branch so the culprit is known — run gate after each apply, not only at the end.)
5. **Contributor attribution:** when B conflicts on `main.ts`, and A (already applied) also touched `main.ts`, `ResolverInput.contributors` includes A. (Uses `changedFiles` per applied branch, cached in a `file → cardId[]` map built as branches apply.)

Implement incrementally, one test at a time. Key structure:

```ts
export async function drain(deps: CoordinatorDeps, projectId: string): Promise<void> {
  if (deps.lock.held(projectId)) return;          // single-flight per project
  await deps.lock.run(projectId, async () => {
    const handle = await deps.git.ensureIntegrationWorktree(...);
    let tip = handle.tip;
    const appliedFiles = new Map<string, string[]>();   // file -> cardIds
    for (const entry of await readReadyQueue(deps.vault, projectId)) {
      const preview = await deps.git.previewMerge(handle.workdir, INTEGRATION_BRANCH, entry.branch);
      if (preview.clean) {
        tip = await deps.git.applyClean(handle.workdir, entry.branch, `merge ${entry.cardId}`);
      } else {
        const contributors = attributeContributors(preview.conflictFiles, appliedFiles, ...);
        const outcome = await deps.resolver({ integrationWorkdir: handle.workdir, incoming: ..., contributors, conflictFiles: preview.conflictFiles });
        if (outcome.kind !== "resolved") { await escalate(deps, entry, outcome, contributors, tip, handle.workdir); continue; }
        tip = (await deps.git.rememberTip(handle.workdir)); // resolver committed
      }
      const gate = await deps.gate(handle.workdir, deps.settings.verify);
      if (!gate.green) { await escalateUnverifiable(deps, entry, gate, tip, handle.workdir); continue; }
      await markMerged(deps.vault, entry, tip);
      for (const f of await deps.git.changedFiles(handle.workdir, deps.settings.base, entry.branch)) {
        appliedFiles.set(f, [...(appliedFiles.get(f) ?? []), entry.cardId]);
      }
    }
    await terminalStep(deps, handle, projectId);   // Task C4
  });
}
```

**Commit after each sub-behavior** (`test:`/`feat:` pairs). Then `pnpm -r typecheck`.

### Task C4: Terminal step switch

`terminalStep` reads the project's `integrationMode`:
- `fast` → `git -C repo merge --ff-only orden/integration` onto `main`; trigger dist rebuild (reuse the existing build invocation, injected); record a `pendingPush` count on a project/status vault key. **Never** pushes origin.
- `measured` → call the existing `publishWorktree({ workdir: integrationWorkdir, branch: INTEGRATION_BRANCH, ... })` to push + open one PR; do not touch main.

**Test:** `integrationMode:"fast"` invokes the ff-merge + rebuild stub and writes `pendingPush`; `"measured"` invokes the publish stub and not the ff-merge. **Commit** `feat: integrationMode terminal step`.

### Task C5: Escalation + resume

`escalate`/`escalateUnverifiable` set the card to `blocked` with `mergeStatus` + `integrationBlock`, reset integration to the prior tip. `resumeOnResolve`: a card change where a blocked card gains `integrationBlock.chosen` → for intent, drop every non-chosen contributor's change (mark each loser `blocked` w/ "goal lost" note) and re-enqueue the chosen; re-drain. **Tests** for both. **Commit** `feat: escalate to blocked + resume on user decision`.

---

## Phase D — Wiring (integration-level; smoke-verified, not unit)

### Task D1: Register the reactor; supersede publish-on-complete

**Files:** Modify `apps/host/src/serve.ts` (after the journal reactor, ~line 129).

Add a memoized `cards` subscriber that calls `enqueueOnComplete` then `drain` for the card's project; and a `cards` subscriber for `resumeOnResolve`. Guard the existing **publish-on-complete** reactor so it no-ops when the coordinator owns integration (the coordinator's `measured` terminal step now performs publish). Keep the `card_complete` dirty-refuse gate untouched. Manual smoke: complete two cards touching disjoint files → both land on main (fast) or get PRs (measured); complete two touching the same file → one merges, the other lands in `blocked` with a question.

**Commit** `feat: wire merge coordinator reactor; route publish through it`.

### Task D2: Real `ResolverRunner` (ephemeral agent)

**Files:** Create `apps/host/src/resolverAgent.ts`.

Spawn a short-lived agent (reuse `launchDetached`/the SDK path) with `cwd` = the integration worktree and a tightly-scoped prompt built from `ResolverInput` (each contributor's planDoc + description + the conflict hunks; instruction: reconcile so ALL goals coexist, commit; or report the goals cannot coexist; or report you cannot verify). Parse its structured result into `ResolverOutcome`. This is integration-tested by hand (a real conflict), not unit — keep the unit suite on the stub from Phase C. **Commit** `feat: ephemeral conflict-resolver agent`.

### Task D3: Reaper recognizes `merged`

**Files:** Modify `apps/host/src/cardReaper.ts` (PUSHED_STATES set, ~line 23) to also reap when `mergeStatus === "merged"`. **Test** in `cardReaper.test.ts`. **Commit** `feat: reap merged-card worktrees`.

---

## Phase E — Web (eyeball-verified against a running host)

Per AGENTS.md, web changes need a `dist` rebuild; verify by running the app, not unit tests. Use the existing seams — do not hand-roll listeners.

### Task E1: Global `integrationMode` setting

`settings.ts` + `settingsBindings.ts` `bindSelect` on a new `vault/settings/app` field; a Fast/Measured select in the Settings popover. **Commit** `feat: integration mode setting`.

### Task E2: Per-project override

`projectModal.ts` — a Fast/Measured/Inherit select beside the worktree-isolation toggle, writing `Project.integrationMode`. **Commit** `feat: per-project integration mode override`.

### Task E3: Render `integrationBlock` on a blocked card

`kanban.ts` — when a blocked card has `integrationBlock`, render the goal-level question and one chip per `options` entry (intent) or the gate-failure summary (unverifiable). No diffs. **Commit** `feat: surface integration decisions on blocked cards`.

### Task E4: Chip click → resolve

Clicking a chip writes `integrationBlock.chosen` through the vault (host write-through), which D1's `resumeOnResolve` reactor consumes. **Commit** `feat: resolve integration decision from the board`.

### Task E5: Fast-mode pending-push surface

Show the `pendingPush` count (a project/status vault key) with a manual "Push to origin" action — the one gated outward step. **Commit** `feat: pending-push indicator + manual origin push`.

---

## Final verification

1. `pnpm -r typecheck` green.
2. `pnpm -r test` green (host coordinator suite is the substantive one).
3. `pnpm --filter @orden/web build`, then run the host (`tsx apps/host/src/serve.ts`) and exercise: two disjoint completions (auto-integrate), two colliding completions (one merges, one blocks with a question), answer the question (loser stays blocked, winner integrates).
4. Update `AGENTS.md` "Architecture: the Host spine" with the coordinator reactor + `merge-queue` ns (propose as a learning at completion).

## Out of scope (carry forward, do not build now)

Work-time cross-agent awareness; remote-aware default mode; multi-target/stacked-PR integration; a `merge_status` MCP survey tool.
