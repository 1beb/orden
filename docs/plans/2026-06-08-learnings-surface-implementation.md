# Learnings Surface Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build orden's learnings review surface — agents propose README/ADR/AGENTS/skill edits when a card completes, the user triages them one at a time (accept/reject/comment) in a new main-panel view — plus the host-rendered `doc_render` MCP tool.

**Architecture:** Two new MCP tools (`doc_render`, `learning_propose`) on the existing `host`-injected registry. A `learnings` vault namespace storing one proposed file-change per record. A derived kanban "learnings" column (no card-state change: a `complete` card with pending learnings buckets there). A new `learnings` main-panel view rendering a stepper over a card's pending learnings, hydrated from the vault and live over the change feed, mirroring the cards/annotations store pattern. Accept writes the file (and commits when the target is a git repo); comment delivers back to the live agent via the existing tmux annotation-delivery path.

**Tech Stack:** TypeScript, pnpm workspace, vitest, zod (MCP schemas), `@modelcontextprotocol/sdk`, Node `child_process` (quarto/git), happy-dom (web tests).

**Design doc:** `docs/plans/2026-06-08-learnings-and-automation-design.md`. Mockup: `docs/mockups/learnings-review.html`.

**Phasing (each phase ships independently):**
- Phase A — `doc_render` MCP tool + quarto capability.
- Phase B — Learning model + `learning_propose` MCP tool + vault storage.
- Phase C — Kanban "learnings" virtual column.
- Phase D — `learnings` main-panel review view (stepper).
- Phase E — Accept / reject / comment behavior (file write + commit; comment delivery).

No git-hook / merge-trigger custodian: orden must work in non-repo working dirs, so learnings come only from the live completing agent via `learning_propose`. Git is used opportunistically on accept (commit when the target happens to be a repo), never required.

---

## Phase A — `doc_render` MCP tool

The host runs quarto; the agent triggers it, checks `ok`, then `panel_open`s the output. Kept separate from `panel_open` so verify-then-open stays explicit.

### Task A1: Render capability flag on HostCapabilities

**Files:**
- Modify: `packages/host-api/src/index.ts` (HostCapabilities, ~lines 5-38)
- Modify: `apps/host/src/nodeHost.ts` (capabilities(), ~lines 185-195)
- Test: `packages/host-api/test/host.test.ts`

**Step 1: Write the failing test** — assert NodeHost capabilities expose a boolean `docRender`.

```typescript
// in apps/host/test/nodeHost.test.ts (add a case)
it("reports docRender capability as a boolean", () => {
  const host = makeNodeHost(); // existing helper
  expect(typeof host.capabilities().docRender).toBe("boolean");
});
```

**Step 2: Run** `pnpm --filter @orden/host exec vitest run -t "docRender capability"` — expect FAIL (undefined).

**Step 3: Implement.** Add to `HostCapabilities`:

```typescript
  /**
   * True when the host can render documents (quarto on PATH). The doc_render
   * MCP tool and the agent render flow are gated on this. Absent/false on the
   * in-browser host and hosts without quarto installed.
   */
  docRender?: boolean;
```

Add a `hasQuarto()` probe in nodeHost.ts (mirror `hasDirectoryPicker`): `execFileSync("quarto", ["--version"])` in a try/catch, memoized. Populate `docRender: hasQuarto()` in `capabilities()`.

**Step 4: Run** the test — expect PASS.

**Step 5: Commit** `feat(host): add docRender capability probe`.

### Task A2: The render function (NodeHost-side)

**Files:**
- Create: `apps/host/src/docRender.ts`
- Test: `apps/host/test/docRender.test.ts`

**Step 1: Write the failing test.** `renderDoc` takes an absolute source path, runs quarto, resolves `{ ok, outputPath?, errors? }`. Test with a mocked `execFile` (inject the runner) — success returns ok+outputPath; non-zero exit returns ok:false+errors. Quarto output path: same dir, rendered extension (`.html` default); read from quarto stdout `Output created: <path>` line, falling back to swapping the extension.

```typescript
import { renderDoc } from "../src/docRender.js";
it("returns ok + outputPath on success", async () => {
  const fakeRun = async () => ({ stdout: "Output created: /repo/doc.html\n", stderr: "", code: 0 });
  const r = await renderDoc("/repo/doc.qmd", fakeRun);
  expect(r).toEqual({ ok: true, outputPath: "/repo/doc.html" });
});
it("returns ok:false + errors on failure", async () => {
  const fakeRun = async () => ({ stdout: "", stderr: "ERROR: bad chunk", code: 1 });
  const r = await renderDoc("/repo/doc.qmd", fakeRun);
  expect(r.ok).toBe(false);
  expect(r.errors).toContain("bad chunk");
});
```

**Step 2: Run** — FAIL (module missing).

**Step 3: Implement** `renderDoc(absPath, run = defaultRun)` where `defaultRun` wraps `execFile("quarto", ["render", absPath])` (cwd = dirname). Parse `Output created:` from stdout for the path; fall back to extension swap. Type: `export interface RenderResult { ok: boolean; outputPath?: string; errors?: string }`.

**Step 4: Run** — PASS.

**Step 5: Commit** `feat(host): renderDoc quarto wrapper`.

### Task A3: `docRender` tool function + registration

**Files:**
- Modify: `packages/mcp/src/tools.ts` (new `docRender` fn)
- Modify: `packages/mcp/src/server.ts` (register; ~near panel_open at line 226)
- Modify: `packages/mcp/src/index.ts` (export)
- Modify: `packages/host-api/src/index.ts` — extend `Host` with optional `render?(projectId, path): Promise<RenderResult>` OR thread through a new optional `FileSource.render`. **Decision:** add `render?` to `Host` (host-level capability, like `chat?`). NodeHost implements it by resolving the project root + path to an absolute path and calling `renderDoc`. BrowserHost omits it.
- Test: `packages/mcp/test/docRender.test.ts`

**Step 1: Write the failing test** against a fake Host whose `render` returns a canned result; assert the tool returns text containing the output path on success and the errors on failure, and a clear "rendering unavailable" when `host.render` is absent.

**Step 2: Run** — FAIL.

**Step 3: Implement.**

```typescript
// tools.ts
export async function docRender(host: Host, projectId: string, path: string): Promise<ToolResult> {
  if (!host.render) return text("doc_render unavailable: host cannot render (quarto not installed?)");
  const r = await host.render(projectId, path);
  if (r.ok) return text(`rendered ${path} -> ${r.outputPath}`);
  return text(`render FAILED for ${path}:\n${r.errors ?? "unknown error"}`);
}
```

Register in server.ts mirroring panel_open, resolving `projectId` from `currentProjectId()` when omitted:

```typescript
server.registerTool(
  "doc_render",
  {
    description:
      "Render a .qmd/.md document on the host (runs quarto) and return build status. Does NOT open anything — on success, follow with panel_open to surface the output. Two tools on purpose: verify the render before opening.",
    inputSchema: {
      path: z.string().describe("repo-relative path to the source doc, e.g. docs/report.qmd"),
      project: z.string().optional().describe("project id; omit to use this session's project"),
    },
  },
  async ({ path, project }) => {
    const pid = project ?? (await currentProjectId()) ?? "repo";
    return tools.docRender(host, pid, path);
  },
);
```

NodeHost.render: resolve root via the existing project-root resolver, `join(root, path)`, call `renderDoc`, and translate the absolute outputPath back to a repo-relative path for the caller.

**Step 4: Run** the mcp suite — PASS.

**Step 5: Commit** `feat(mcp): doc_render tool`.

### Task A4: Document the flow in AGENTS.md

**Files:** Modify `AGENTS.md` (under "MCP agent bus").

Add the host-owned/agent-driven render paragraph (the exact text is the first learning in the mockup). Commit `docs: document doc_render/panel_open render flow`.

---

## Phase B — Learning model + `learning_propose` tool

### Task B1: The Learning type + vault helpers

**Files:**
- Create: `packages/mcp/src/learnings.ts` (type + CRUD helpers over the vault)
- Modify: `packages/mcp/src/index.ts` (export)
- Test: `packages/mcp/test/learnings.test.ts`

**Type:**

```typescript
export type LearningType = "readme" | "adr" | "agents" | "skill";
export type LearningStatus = "pending" | "accepted" | "rejected";

export interface Learning {
  id: string;
  cardId: string;
  sessionId?: string;
  projectId: string;
  type: LearningType;
  title: string;
  recap: string;            // per-learning context, shown at the bottom of the step
  targetPath: string;       // project-relative file to edit/create
  op: "edit" | "create";
  proposedContent: string;  // FULL file content to write on accept (not a patch)
  baseContent?: string;     // current file content for diff display (edit only)
  status: LearningStatus;
  comments?: { at: number; text: string }[];
  createdAt: number;
}
```

Rationale for full `proposedContent` over a patch: accept becomes a single `files.write`, no fragile patch application; the UI computes the displayed diff from `baseContent` → `proposedContent`.

**Helpers** (vault ns `"learnings"`, key = learning id): `putLearning`, `getLearning`, `listLearnings(vault)`, `listLearningsForCard(vault, cardId)`, `setLearningStatus`, `addLearningComment`.

**Step 1–5 (TDD):** test put→get round-trips; `listLearningsForCard` filters by cardId; `setLearningStatus` flips status and preserves other fields. Implement minimal. Commit `feat(mcp): learnings vault model`.

### Task B2: `learning_propose` MCP tool

**Files:**
- Modify: `packages/mcp/src/tools.ts` (new `learningPropose`)
- Modify: `packages/mcp/src/server.ts` (register)
- Modify: `packages/mcp/src/index.ts`
- Test: `packages/mcp/test/learningPropose.test.ts`

**Behavior:** Bind cardId/projectId from the session context (`currentCardId`/`currentProjectId`). For `op:"edit"`, read current file content into `baseContent` (best effort; on miss, treat as create). Persist a `Learning` with `status:"pending"`. Returns text confirming, with the learning id.

**Schema:**

```typescript
inputSchema: {
  type: z.enum(["readme", "adr", "agents", "skill"]),
  title: z.string(),
  recap: z.string().describe("1-3 sentences: why this learning, from the session's work"),
  path: z.string().describe("project-relative target file (created if missing)"),
  content: z.string().describe("the FULL proposed file content after the change"),
}
```

**Step 1: Write failing test** — fake Host with a stub `files.read`; call proposes a learning; assert a record lands in ns `learnings` with `op:"edit"` + captured `baseContent` when the file exists, `op:"create"` when read throws.

**Step 2–4:** implement, pass.

**Step 5: Commit** `feat(mcp): learning_propose tool`.

### Task B3: Register learning tools in server INSTRUCTIONS + AGENTS.md guidance

**Files:** Modify `packages/mcp/src/server.ts` (INSTRUCTIONS text) and `AGENTS.md`.

Add to the MCP server instructions: "When the user says to complete a card, before calling card_complete, distill what the session changed into learnings and call learning_propose once per proposed README/ADR/AGENTS/skill edit. Do not propose memories." Mirror in AGENTS.md. Commit `docs: instruct agents to propose learnings on completion`.

---

## Phase C — Kanban "learnings" virtual column

A `complete` card with ≥1 pending learning renders in a new rightmost "Learnings" column. Card `state` is untouched (stays `complete`), so no state-machine/MCP/hook/reactor changes.

### Task C1: Expose pending-learnings count to the web

**Files:**
- Create: `apps/web/src/learningsStore.ts` (hydrate + cache, mirroring `cards.ts`/`annotationStore.ts`)
- Modify: `apps/web/src/main.ts` (`hydrateAll`, change-feed `case "learnings"`)
- Test: `apps/web/test/learningsStore.test.ts`

Store API: `hydrateLearnings(host)`, `listLearnings()`, `learningsForCard(cardId)`, `pendingForCard(cardId): number`, plus mutation write-throughs used later in Phase E (`setStatus`, `addComment`). Follow the annotationStore write-through pattern exactly.

**Step 1: Test** hydrate populates cache from vault ns `learnings`; `pendingForCard` counts only `status==="pending"`. **Steps 2–4:** implement. **Step 5: Commit** `feat(web): learnings store`.

### Task C2: Bucket complete+pending cards into a Learnings column

**Files:**
- Modify: `packages/outliner/src/kanban.ts` (`LIFECYCLE_ORDER` — append `"learnings"`)
- Modify: `packages/outliner/src/types.ts` (`LifecycleState` — add `"learnings"`; it's a column id, never a stored card state)
- Modify: `packages/outliner/src/kanbanView.ts`, `apps/web/src/kanban.ts`, `apps/web/src/cardModal.ts`, `apps/web/src/issueList.ts` (`STATE_LABELS` — add `learnings: "Learnings"`)
- Modify: `apps/web/src/kanban.ts` (bucketing: a card with `state==="complete"` AND `pendingForCard(id) > 0` goes to the `learnings` column instead of `complete`)
- Modify: `apps/web/src/cardModal.ts` — exclude `learnings` from the user's state dropdown (it's not a settable state; filter it out of the `LIFECYCLE_ORDER` loop)
- Test: `apps/web/test/kanban.test.ts`, `packages/outliner/test/kanban.test.ts`

**Step 1: Write failing test** (web kanban): given a complete card with a pending learning, it renders under the Learnings column, not Complete; with no pending learnings it stays under Complete.

**Step 2: Run** — FAIL.

**Step 3: Implement** the bucketing predicate. Inject `pendingForCard` via the existing `KanbanDeps` (add a `pendingLearnings(cardId): number` dep so `kanban.ts` stays free of store imports; wire it in `refreshBoard()` from `learningsStore`).

**Step 4: Run** web + outliner kanban suites — PASS. Update any fixture that now expects the extra column.

**Step 5: Commit** `feat(web): derived learnings kanban column`.

### Task C3: Nav badge + click-through

**Files:** Modify `apps/web/src/main.ts` (the action-count badge already sums needs-action; include pending-learnings cards). Clicking a Learnings-column card opens the learnings view (Phase D) for that card via the same panel-intent mechanism. Defer the open wiring to Phase D; here just ensure the column cards are clickable placeholders.

Commit `feat(web): learnings count in nav badge`.

---

## Phase D — `learnings` main-panel review view

The stepper from the mockup. One card at a time; per-learning recap at the bottom; ✕ Reject / ✓ Accept row; comment field + Send beneath; auto-advance.

### Task D1: Register the view shell

**Files:**
- Modify: `apps/web/src/viewState.ts` (`View` union — add `"learnings"`)
- Modify: `apps/web/index.html` (add `<section id="view-learnings" class="view"></section>` after `#view-kanban`)
- Modify: `apps/web/src/main.ts` (`viewEls` map; `viewStore.subscribe` title table → `learnings: "Learnings"`; render call)
- Test: `apps/web/test/viewState.test.ts`

**Step 1: Test** the view store accepts `"learnings"` and the swap toggles only `#view-learnings`. **Steps 2–4:** implement. **Step 5: Commit** `feat(web): register learnings view`.

### Task D2: Render the stepper (mockup → live DOM)

**Files:**
- Create: `apps/web/src/learningsView.ts` (`renderLearnings(container, deps)`)
- Modify: `apps/web/src/main.ts` (call it on view switch + on `case "learnings"` change feed; track the active card id + the current step index in module state)
- Create: CSS in `apps/web/src/styles.css` (port the mockup classes: `.lr`, `.lr-head`, `.dots`, `.recap`, `.diff`, `.verdict`, `.comment-row` — using the real tokens, which the mockup already mirrors)
- Test: `apps/web/test/learningsView.test.ts`

**Behavior:** `renderLearnings` reads `learningsForCard(activeCardId).filter(pending)`, renders the current step (progress `n / N`, dot indicator, title, kind line, plain `+/-` diff computed from base→proposed, "Why this" recap always visible, action bar). Empty state when no pending learnings ("All learnings reviewed").

**Step 1: Write failing test** — mount into a happy-dom container with two seeded learnings; assert the first renders (title, progress "1 / 2", a diff row, the recap text, Accept/Reject/Send controls present).

**Step 2: Run** — FAIL.

**Step 3: Implement** the renderer. Diff display: line-by-line over `baseContent` vs `proposedContent` (a minimal LCS or, for v1, show removed `baseContent` block then added `proposedContent` block with `-`/`+` gutters — keep it readable, not a full Myers diff).

**Step 4: Run** — PASS.

**Step 5: Commit** `feat(web): learnings stepper view`.

### Task D3: Open the view for a card

**Files:** Modify `apps/web/src/kanban.ts` (Learnings-column card click → set active learnings card + `viewStore.set("learnings")`) and `apps/web/src/main.ts` (wire the handler; also accept a `panel_open kind:"card"`-style intent to open learnings). 

**Step 1: Test** clicking a learnings card switches the view and sets the active card. **Steps 2–4.** **Step 5: Commit** `feat(web): open learnings view from board`.

---

## Phase E — Accept / Reject / Comment behavior

### Task E1: Reject + Comment (no file I/O)

**Files:**
- Modify: `apps/web/src/learningsStore.ts` (`setStatus(id,"rejected")`, `addComment(id,text)` write-throughs)
- Modify: `apps/web/src/learningsView.ts` (wire ✕ → reject + auto-advance; Send → addComment + deliver)
- Test: `apps/web/test/learningsView.test.ts`

Reject flips status (card may leave the Learnings column once no pending remain — falls back to Complete, already handled by C2's predicate). Comment appends and triggers delivery (E3).

**Step 1: Test** reject removes the learning from the pending set and advances to the next. **Steps 2–4.** **Step 5: Commit** `feat(web): reject + comment learnings`.

### Task E2: Accept — write the file (+ commit when a repo)

**Files:**
- Create: `apps/host/src/applyLearning.ts` (host-side apply: `host.files.write(projectId, targetPath, proposedContent)`; then if the project root is a git work-tree, `git add <path> && git commit -m "learning: <title>"`; PR generation deferred)
- Modify: `packages/host-api/src/index.ts` — add `Host.applyLearning?(learningId): Promise<{ written: true; committed: boolean }>` OR expose as an MCP/RPC action callable from the web. **Decision:** expose via a new web→host RPC method (the web triages, the host applies) to keep git on the host. Wire in `apps/host/src/rpc.ts`.
- Modify: `apps/web/src/learningsView.ts` (✓ → call the RPC, then `setStatus(id,"accepted")`, then auto-advance)
- Test: `apps/host/test/applyLearning.test.ts` (mock the git runner; assert write happens; assert commit only when `git rev-parse` succeeds), plus a web test that Accept calls the RPC and marks accepted.

**Git detection:** `git -C <root> rev-parse --is-inside-work-tree` via injected runner. Non-repo (or detection fails) → write-to-disk only, `committed:false`.

**Step 1–5 (TDD):** Commit `feat: apply accepted learning (write + optional commit)`.

### Task E3: Deliver comments back to the live agent

**Files:**
- Modify: `apps/host/src/rpc.ts` + a host method that, given a learning's `cardId`/`sessionId`, types the comment into the live agent pane via the existing `SessionManager.annotationSend`/tmux delivery path (reuse, don't reinvent).
- Test: `apps/host/test/learningComment.test.ts` (assert it resolves the session from the card and calls the delivery fn; mirror the existing annotationDelivery test's "never throws" guarantee).

**Step 1–5 (TDD):** Commit `feat: deliver learning comments to the session`.

### Task E4: Full-suite green + typecheck

Run `pnpm -r typecheck` and `pnpm -r test`. Fix fallout (fixtures expecting old column count, new optional Host fields in BrowserHost). Rebuild the web bundle (`pnpm --filter @orden/web build`) and smoke-test against a running host per `docs/run-orden-locally` (memory): complete a card, see learnings appear, triage one. Commit `test: learnings surface green`.

---

## Out of scope (this plan)

- Any git-hook / merge-trigger custodian. Dropped by design — orden must work in non-repo dirs, so there is no repo-wide drift sweep. Learnings come only from the live completing agent.
- Auto-generation of learnings by the host (we rely on the live completing agent + `learning_propose`).
- PR creation on accept (commit only for v1).
- Full Myers diff rendering (block-level +/- for v1).

## Conventions

- TDD: failing test first, minimal impl, green, commit. One logical change per commit.
- After each phase: `pnpm -r typecheck` + the touched package's `test` must be 100% green.
- No `git add .` — stage named files. No Claude attribution in commits.
- Web changes need `pnpm --filter @orden/web build` before the host serves them (no HMR).
