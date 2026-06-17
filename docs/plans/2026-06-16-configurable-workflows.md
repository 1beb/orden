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

NOTE (2026-06-17): the canonical design is now
`docs/plans/2026-06-17-configurable-workflows-consolidated.md` (the runbook model). The
Stage 1 tasks below shipped against the earlier stages-as-columns model; the closed-
effects substrate they built (catalog, executor registry, resolver) survives unchanged.
The model types migrate from `Stage[]` to a runbook `Step[]` in Stage 1b. Stages 2/3 are
reshaped around the runbook below.

- Stage 1 (DONE): the pure `packages/workflows` module — types, catalog, default,
  parser, validator, resolver. 29 tests.
- Stage 1b (NEW): migrate the model from `Stage[]` to a runbook `Step[]` discriminated
  union (`prose` | `primitive` | `gate`) with a role for board projection; keep the
  catalog/validator/resolver, adapt their shapes; regenerate `DEFAULT_WORKFLOW` as a
  runbook.
- Stage 2 (host runbook engine): session-level resolver + multi-workflow directory
  discovery, extend the executor registry (add `run`/`check`, `notify`, `capture`, etc.),
  a host-side step runner that walks the runbook and evaluates control flow, gates as
  durable vault suspensions, the role-based board projection, and the dirty-state rule.
- Stage 3 (authoring + selection): the `workflow_*` MCP capability, per-harness guidance
  (Claude skill + opencode wrapper), the compile/validate/confirm authoring UI, the
  agent-suggest + operator-confirm selection, and the per-repo workflow picker.

Each stage merges to main and rebuilds dist before the next begins (repo policy:
single-user, integrate as you go). Behavior-changing work (Stage 2 onward) gets an
app-run regression check: the `default` workflow must behave exactly as orden does today.

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

## Stage 1b — Migrate the model to a runbook of typed steps (OUTLINE)

Keep the catalog/validator/resolver substrate; change the model shape. All in
`packages/workflows`, still pure, still TDD.

1. `Step` discriminated union (`types.ts`): `kind: "prose" | "primitive" | "gate"`, a
   `role` (`initial`/`active`/`waiting`/`terminal`) for board projection, and kind-
   specific fields — prose carries the agent settings (`models`/`aggregate` move here),
   primitive carries `{ action, params }`, gate carries `{ gate }`. `WorkflowSpec.steps:
   Step[]` replaces `stages: Stage[]`.
2. Adapt the validator to runbook rules: every `primitive` action and `gate` is in the
   catalog (error otherwise); a terminal-role step exists; the trade-off + multi-model
   warnings re-expressed over steps.
3. Adapt the resolver `extends` merge to steps (by step id), preserving the
   inherit-by-id semantics.
4. Regenerate `DEFAULT_WORKFLOW` as the six-step runbook from
   `2026-06-17-default-workflow-two-framings.md` (Framing B).
5. Gate: `pnpm --filter @orden/workflows test` + `pnpm -r typecheck`.

## Stage 2 — Host runbook engine (OUTLINE)

Where live behavior changes; default runbook must behave exactly as orden does today.

1. Session-level resolver: extend `workflowResolver.ts` to
   `resolveSessionWorkflow(host, sessionId)` = `session.workflow ?? project.defaultWorkflow
   ?? DEFAULT_WORKFLOW`. Multi-workflow discovery: list `.orden/workflows/*.md` (repo) +
   vault `workflows` ns; repo shadows vault on name collision.
2. Extend the executor registry (`workflowExecutors.ts`) with the new effects — `run`/
   `check`, `notify`, `capture`, `code-review` — each a real host executor; flip `merge`/
   `verify` from pending to implemented as they land. Contract test stays green throughout.
3. Step runner: a host-side router that walks the resolved runbook, evaluates control
   flow (sequence, conditional routing on a step outcome, the one rework loop), and
   invokes the executor for `primitive` steps / prompts the agent for `prose` steps.
   Control flow is host-evaluated — never delegated to the agent.
4. Gates as durable vault suspensions: a `gate` step parks on a vault key; the
   annotation/approve write is the resume signal carrying the operator's decision; the
   runner resumes and branches on it. Survives host restart.
5. Board projection: derive the card's column from the active step's `role`; the existing
   completion reactors (reap/publish/journal) become executors invoked by the terminal
   step instead of firing unconditionally on `state === "complete"` (behavior-neutral
   under the default runbook).
6. Dirty-state rule: any step that cannot cleanly run parks the card in the waiting role
   with a reason, honoring the `dirtyTree` policy.
7. Stage gate: `pnpm -r typecheck && pnpm -r test`, then an app-run regression check —
   complete a card under the default runbook and confirm publish/journal/reap are
   identical to today (@superpowers:verification-before-completion).

## Stage 3 — Authoring, selection, and UI (OUTLINE)

1. `workflow_*` MCP capability (`packages/mcp`): `list` / `propose` / `validate` / `save`
   / `render`, delegating to `@orden/workflows`. Mirror over the agent HTTP fallback like
   `panel_open`/`card_move`.
2. Compile: `packages/workflows/src/compileSpec.ts` (LLM prompt + the `WorkflowSpec` JSON
   schema, pure data); host runs the LLM over the prose, validates, persists on confirm.
3. Per-harness guidance, one source: a Claude skill + an opencode wrapper (custom command
   / AGENTS guidance via the generated opencode plugin) carrying the runbook-authoring
   process + the primitive catalog + the operator's saved composites.
4. Web: the compile/validate/confirm authoring view (reads back the mapping, flags
   un-mappable prose, shows warnings), the runbook diagram, the per-repo workflow picker,
   and the agent-suggest + operator-confirm selection at session-create. Center view via
   the view registry; settings via settingsBindings.
5. Composites: named, version-pinned, parameterizable bundles of primitives + prose
   (data, not code).
6. Stage gate + dist rebuild.

## Open questions (see consolidated design doc)

- Per-step agent override vs a single session spanning many steps (worktree/branch
  sharing across steps).
- Switching a card's workflow mid-run: re-map the active step or restart.
- Concrete on-disk runbook syntax (numbered typed list vs frontmatter step table).
- Composite parameterization surface (typed inputs, like GitLab `spec:inputs`).
- Generating the `default` runbook markdown from `DEFAULT_WORKFLOW` as the reference.
