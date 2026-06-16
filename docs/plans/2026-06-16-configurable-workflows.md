# Configurable Workflows Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make orden's lifecycle, completion policy, and in-session agent behavior
configurable per project via a text (markdown) workflow definition, replacing today's
hard-coded pipeline.

**Architecture:** A pure `packages/workflows` module owns the model: a `WorkflowSpec`
type, the closed primitive catalog (single source of truth), a markdown parser, a
validator, and the built-in `default` spec that reproduces today's behavior exactly. The
host resolves a project's spec (default + vault + repo override) and its reactors read
the spec instead of hard-coded behavior; a contract test enforces catalog<->executor
bijection. Web compiles prose->spec via an LLM at save time, shows a confirm/validate
screen, and offers a per-project picker. Design doc:
`docs/plans/2026-06-16-configurable-workflows-design.md`.

**Tech Stack:** TypeScript, vitest, pnpm workspace. New package mirrors
`packages/annotation-core` (pure, no Node/fs deps).

---

## Staging

- Stage 1 (this plan, detailed): the pure `packages/workflows` module. No behavior
  change anywhere else; fully unit-tested in isolation.
- Stage 2 (outlined): host resolver + reactors read the spec + contract test. This is
  where live behavior changes; detail it once Stage 1's types exist.
- Stage 3 (outlined): LLM compile-on-save, confirm/validate UI, diagram, per-project
  picker.

Each stage merges to main and rebuilds dist before the next begins (repo policy:
single-user, integrate as you go).

---

## Stage 1 — The pure `packages/workflows` module

Relevant skills: @superpowers:test-driven-development, @superpowers:executing-plans.

### Task 1: Scaffold the package

**Files:**
- Create: `packages/workflows/package.json`
- Create: `packages/workflows/tsconfig.json`
- Create: `packages/workflows/vitest.config.ts`
- Create: `packages/workflows/src/index.ts` (empty `export {}` for now)

**Step 1:** Copy `packages/annotation-core/{package.json,tsconfig.json,vitest.config.ts}`,
rename in package.json to `@orden/workflows`, drop the `happy-dom` devDep (not needed).

**Step 2:** `pnpm install` at repo root so the workspace links the package.

**Step 3:** Run `pnpm --filter @orden/workflows typecheck`. Expected: passes (empty).

**Step 4:** Commit. `git add packages/workflows && git commit -m "workflows: scaffold pure package"`

### Task 2: Types and catalog (single source of truth)

**Files:**
- Create: `packages/workflows/src/types.ts`
- Create: `packages/workflows/src/catalog.ts`
- Test: `packages/workflows/test/catalog.test.ts`

**Step 1 — failing test:** assert the catalog enumerates the closed sets and that the
type-guards reject unknowns.

```ts
import { describe, it, expect } from "vitest";
import { STAGE_ROLES, GATES, ACTIONS, isAction, isGate, isStageRole } from "../src/catalog";

describe("catalog", () => {
  it("enumerates the closed primitive sets", () => {
    expect([...STAGE_ROLES]).toEqual(["initial", "active", "waiting", "terminal"]);
    expect([...GATES]).toEqual(["approve", "review"]);
    expect([...ACTIONS]).toEqual([
      "journal", "push", "open-pr", "merge", "reap", "propose-learnings", "verify",
    ]);
  });
  it("guards reject unknown ids", () => {
    expect(isAction("push")).toBe(true);
    expect(isAction("nope")).toBe(false);
    expect(isGate("approve")).toBe(true);
    expect(isStageRole("terminal")).toBe(true);
    expect(isStageRole("done")).toBe(false);
  });
});
```

**Step 2:** Run it; expect FAIL (module not found).

**Step 3 — implement.** `types.ts`:

```ts
export type StageRole = "initial" | "active" | "waiting" | "terminal";
export type Gate = "approve" | "review";
export type Action =
  | "journal" | "push" | "open-pr" | "merge" | "reap" | "propose-learnings" | "verify";
export type Harness = "claude" | "opencode";
export type SessionMode = "tui" | "gui";
export interface AgentSettings {
  harness?: Harness;
  isolate?: boolean;
  mode?: SessionMode;
  gitGuard?: boolean;
}
export type CompletionOutput = "none" | "push" | "push+pr" | "push+merge";
export type DirtyTreePolicy = "commit-and-push" | "push-committed" | "ask";
export interface Stage {
  id: string;        // canonical id (slug of label)
  label: string;     // operator's display word
  role: StageRole;
  gates: Gate[];
  onEnter: Action[];
  onExit: Action[];
  agent?: AgentSettings;
}
export interface WorkflowSpec {
  name: string;
  extends?: string;
  stages: Stage[];
  agent?: AgentSettings;            // workflow-wide default
  completion?: CompletionOutput;    // what the terminal stage produces
  dirtyTree?: DirtyTreePolicy;      // how to handle an uncommitted tree at publish
  learningKinds?: string[];         // readme/adr/agents/skill, extensible
}
```

`catalog.ts`:

```ts
import type { Action, Gate, StageRole } from "./types";
export const STAGE_ROLES = ["initial", "active", "waiting", "terminal"] as const;
export const GATES = ["approve", "review"] as const;
export const ACTIONS = [
  "journal", "push", "open-pr", "merge", "reap", "propose-learnings", "verify",
] as const;
/** Actions that are irreversible / outward-facing; the validator warns on these. */
export const IRREVERSIBLE_ACTIONS: ReadonlySet<Action> = new Set(["push", "open-pr", "merge"]);
export const isStageRole = (s: string): s is StageRole => (STAGE_ROLES as readonly string[]).includes(s);
export const isGate = (s: string): s is Gate => (GATES as readonly string[]).includes(s);
export const isAction = (s: string): s is Action => (ACTIONS as readonly string[]).includes(s);
```

**Step 4:** Run test; expect PASS. **Step 5:** Commit `workflows: types + primitive catalog`.

### Task 3: The built-in `default` spec (reproduces today's behavior)

**Files:**
- Create: `packages/workflows/src/default.ts`
- Test: `packages/workflows/test/default.test.ts`

**Step 1 — failing test:** the default mirrors today's lifecycle and completion.

```ts
import { describe, it, expect } from "vitest";
import { DEFAULT_WORKFLOW } from "../src/default";

describe("default workflow", () => {
  it("has today's four stages in order with correct roles", () => {
    expect(DEFAULT_WORKFLOW.stages.map((s) => [s.label, s.role])).toEqual([
      ["Planning", "initial"],
      ["In-progress", "active"],
      ["Blocked", "waiting"],
      ["Complete", "terminal"],
    ]);
  });
  it("gates plan approval and evidence review", () => {
    const planning = DEFAULT_WORKFLOW.stages.find((s) => s.role === "initial")!;
    expect(planning.gates).toContain("approve");
    expect(DEFAULT_WORKFLOW.stages.some((s) => s.gates.includes("review"))).toBe(true);
  });
  it("publishes and reaps on complete, never merges", () => {
    const terminal = DEFAULT_WORKFLOW.stages.find((s) => s.role === "terminal")!;
    expect(terminal.onEnter).toEqual(
      expect.arrayContaining(["journal", "push", "open-pr", "reap", "propose-learnings"]),
    );
    expect(terminal.onEnter).not.toContain("merge");
    expect(DEFAULT_WORKFLOW.completion).toBe("push+pr");
  });
  it("defaults agent to isolated claude TUI with the git guard on", () => {
    expect(DEFAULT_WORKFLOW.agent).toEqual({
      harness: "claude", isolate: true, mode: "tui", gitGuard: true,
    });
  });
});
```

**Step 2:** Run; FAIL. **Step 3:** Implement `DEFAULT_WORKFLOW` to satisfy it (stages with
ids = slug of label; `learningKinds: ["readme","adr","agents","skill"]`,
`dirtyTree: "ask"`). **Step 4:** PASS. **Step 5:** Commit `workflows: built-in default spec`.

### Task 4: Markdown parser (headings -> stages skeleton)

**Files:**
- Create: `packages/workflows/src/parse.ts`
- Test: `packages/workflows/test/parse.test.ts`

The parser is deterministic and does NOT infer primitives (that is the LLM compile step).
It returns frontmatter + an ordered list of `{ label, prose }` for each `##` heading.

**Step 1 — failing test:**

```ts
import { describe, it, expect } from "vitest";
import { parseWorkflowMarkdown } from "../src/parse";

const SRC = `---
name: Code (PR)
extends: default
---

## Planning

Write a plan and let me approve it.

## Complete

Push and open a PR.
`;

describe("parseWorkflowMarkdown", () => {
  it("reads frontmatter and ordered stages with prose", () => {
    const p = parseWorkflowMarkdown(SRC);
    expect(p.name).toBe("Code (PR)");
    expect(p.extends).toBe("default");
    expect(p.stages).toEqual([
      { label: "Planning", prose: "Write a plan and let me approve it." },
      { label: "Complete", prose: "Push and open a PR." },
    ]);
  });
  it("tolerates a missing frontmatter block", () => {
    const p = parseWorkflowMarkdown("## Only\n\nDo a thing.\n");
    expect(p.name).toBeUndefined();
    expect(p.stages).toEqual([{ label: "Only", prose: "Do a thing." }]);
  });
});
```

**Step 2:** FAIL. **Step 3:** Implement with a small hand-rolled parser (split frontmatter
on leading `---` block, parse `name:`/`extends:`; split body on `^## ` headings; trim
prose). No new dependency. **Step 4:** PASS. **Step 5:** Commit `workflows: markdown parser`.

### Task 5: Validator (trade-off warnings + unknown-primitive errors)

**Files:**
- Create: `packages/workflows/src/validate.ts`
- Test: `packages/workflows/test/validate.test.ts`

`validateWorkflow(spec): { errors: string[]; warnings: string[] }`. Errors = references to
primitives not in the catalog (or no terminal stage). Warnings = the design's footguns.

**Step 1 — failing test** covering: clean default => no errors/warnings; `push+merge`
with no review gate => warning; `isolate:false`+`gitGuard:false` => warning; no `approve`
gate anywhere => warning; terminal stage with `completion:"none"` => warning; an onEnter
action not in the catalog => error.

**Step 2:** FAIL. **Step 3:** Implement the rule set (use `isAction`/`isGate`,
`IRREVERSIBLE_ACTIONS`, role lookups). **Step 4:** PASS. **Step 5:** Commit
`workflows: spec validator`.

### Task 6: Inheritance resolver (`extends`)

**Files:**
- Create: `packages/workflows/src/resolve.ts`
- Test: `packages/workflows/test/resolve.test.ts`

`resolveSpec(partial, base = DEFAULT_WORKFLOW): WorkflowSpec` — deep-merges a partial spec
onto its base so a workflow only states what differs. Stage-level merge is by `id`.

**Step 1 — failing test:** a partial that only changes `completion` to `push` and adds
`merge` to the terminal stage inherits everything else from default; an empty partial
equals the default. **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
**Step 5:** Commit `workflows: extends/inheritance resolver`.

### Task 7: Public surface + workspace wiring

**Files:**
- Modify: `packages/workflows/src/index.ts`
- Test: `packages/workflows/test/index.test.ts`

**Step 1:** Re-export everything public from `index.ts`; test imports the package entry
and asserts `DEFAULT_WORKFLOW`, `parseWorkflowMarkdown`, `validateWorkflow`,
`resolveSpec`, catalog members are all reachable. **Step 2:** FAIL. **Step 3:** Implement
the barrel. **Step 4:** Run `pnpm --filter @orden/workflows test` and
`pnpm --filter @orden/workflows typecheck`; both PASS. **Step 5:** Commit
`workflows: public surface`.

### Task 8: Stage-1 gate

Run `pnpm -r typecheck` and `pnpm -r test`. Expect 100% pass (no other package touched).
This is the merge point for Stage 1.

---

## Stage 2 — Host resolver + reactors read the spec (OUTLINE)

Detail after Stage 1 lands. Tasks, roughly:

1. `apps/host/src/workflowResolver.ts`: resolve a project's `WorkflowSpec` —
   `DEFAULT_WORKFLOW` <- vault `workflows/<name>.md` <- project repo `.orden/workflow.md`,
   using `parseWorkflowMarkdown` + `resolveSpec`. (The prose->primitive *compile* is
   Stage 3; until then the resolver consumes already-compiled specs persisted in the
   vault, falling back to `DEFAULT_WORKFLOW`.)
2. Executor registry: a host map from each catalog `Action`/`Gate` to its implementation
   (`journal`->cardJournal, `push`/`open-pr`/`merge`->publishReactor, `reap`->cardReaper,
   `propose-learnings`->existing learnings flow, `verify`->new agentic check).
3. Contract test (`apps/host/src/workflows.contract.test.ts`): assert bijection — every
   `ACTIONS`/`GATES` member has a registered executor and every registered executor id is
   in the catalog. Fails the build on drift.
4. Rewire the four `host.onChange` reactors in `serve.ts` to read the resolved spec's
   terminal-stage `onEnter` instead of unconditionally publishing/journaling/reaping.
   `LIFECYCLE_ORDER` becomes the resolved spec's stage ids (compat shim: default spec ==
   today's literal four states).
5. Dirty-state rule: completion that cannot cleanly run its actions moves the card to the
   `waiting`-role stage with a reason (generalize publishSession's clean-tree refusal),
   honoring the spec's `dirtyTree` policy.
6. `verify` primitive: runs an agent against a criterion; fail/uncertain calls
   `card_create` (raise a card); gate-position verify holds the stage.
7. Stage gate: `pnpm -r typecheck && pnpm -r test`, then run the app and confirm the
   default workflow behaves exactly as before (no regression) per @superpowers:verification-before-completion.

## Stage 3 — Compile-on-save + web UI (OUTLINE)

1. `packages/workflows/src/compileSpec.ts`: the LLM prompt + the JSON schema for a
   `WorkflowSpec` (pure data; no LLM call here).
2. Host: a compile endpoint that runs the LLM over parsed prose -> `WorkflowSpec`,
   validates, persists to the vault on confirm.
3. Web: confirm/validate screen (reads back the mapping, flags un-mappable prose, shows
   `validateWorkflow` warnings), a read-only pipeline diagram, and a per-project workflow
   picker. New center view via the view registry; settings via settingsBindings.
4. Stage gate + dist rebuild.

## Open questions (from the design doc)

- Project-override on-disk path (`.orden/workflow.md` vs other).
- Whether stage roles must be unique (two `waiting` stages?).
- Per-stage agent override vs a session spanning stages.
- Generating the `default` workflow markdown from `DEFAULT_WORKFLOW` as the reference.
