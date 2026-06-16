// The merge coordinator: a host-side, autonomous integration loop. Completed
// session branches enqueue into the `merge-queue` vault namespace; drain() pulls
// them serially onto ONE integration worktree (Bors / Not-Rocket-Science Rule),
// resolving implementation conflicts with intent context and escalating only
// genuine intent collisions or unverifiable resolutions.
//
// Everything that touches a repo, a build, or an agent is injected (CoordinatorGit
// / ResolverRunner / gate / plan / terminalStep) so the loop is fully unit-tested
// without real git, agents, or builds. See
// docs/plans/2026-06-15-merge-coordinator-design.md.

import type { VaultStore, Project } from "@orden/host-api";
import { type CardRec, cardSessionIds } from "@orden/mcp";
import {
  MERGE_QUEUE_NS,
  type MergeQueueEntry,
  type IntegrationBlock,
} from "./mergeTypes";
import {
  INTEGRATION_BRANCH,
  type IntegrationHandle,
  type IntegrationInput,
  type MergePreview,
  type StackResult,
} from "./integrationBranch";

// --- Resolver seam -----------------------------------------------------------

export interface IntentRef {
  cardId: string;
  branch: string;
  title?: string;
  planDoc?: string;
  description?: string;
}

export interface ResolverInput {
  integrationWorkdir: string;
  incoming: IntentRef;
  /** Already-integrated siblings whose hunks the incoming branch collides with (1..N). */
  contributors: IntentRef[];
  conflictFiles: string[];
}

export type ResolverOutcome =
  | { kind: "resolved" } // committed a reconciliation in the integration worktree
  | { kind: "intent-conflict"; question: string; options: string[] }
  | { kind: "unverifiable"; question: string };

export type ResolverRunner = (input: ResolverInput) => Promise<ResolverOutcome>;

// --- Injected surfaces -------------------------------------------------------

export interface CoordinatorGit {
  ensureIntegrationWorktree(input: IntegrationInput): Promise<IntegrationHandle>;
  previewMerge(cwd: string, into: string, incoming: string): Promise<MergePreview>;
  applyClean(cwd: string, incoming: string, message: string): Promise<string>;
  /** Try to replay incoming's commits (base..incoming) atop the integration tip. */
  stackOnto(cwd: string, base: string, incoming: string): Promise<StackResult>;
  resetIntegration(cwd: string, priorTip: string): Promise<void>;
  currentTip(cwd: string): Promise<string>;
  changedFiles(cwd: string, base: string, branch: string): Promise<string[]>;
}

export interface DrainPlan {
  repo: string;
  integrationRoot: string;
  base: string;
  /** Gate command (any shell); "" = no semantic gate, textual merge only. */
  verify: string;
  /** Post-merge command for `fast` mode; "" = none. */
  rebuild: string;
  mode: "fast" | "measured";
  project: Project | null;
}

export interface TerminalContext {
  handle: IntegrationHandle;
  projectId: string;
  mode: "fast" | "measured";
  mergedCardIds: string[];
  plan: DrainPlan;
}

export interface CoordinatorDeps {
  vault: VaultStore;
  git: CoordinatorGit;
  resolver: ResolverRunner;
  gate: (cwd: string, command: string) => Promise<{ green: boolean; output: string }>;
  /** Resolve per-project paths + integration settings. */
  plan: (projectId: string) => Promise<DrainPlan>;
  /** The mode-specific terminal step (ff-merge+rebuild / push+PR). Stubbed in tests. */
  terminalStep: (ctx: TerminalContext) => Promise<void>;
}

// --- Queue read/write --------------------------------------------------------

const uniq = (xs: string[]): string[] => [...new Set(xs)];

const intentOf = (card: CardRec | null, branch: string, cardId: string): IntentRef => ({
  cardId,
  branch,
  title: card?.title,
  planDoc: card?.planDoc,
  description: card?.description,
});

// The card's integration branch: the publish-gate stamp if present, else the
// branch on the first linked session record (HOST_OWNED). Decouples enqueue from
// whether the publish gate stamped a branch.
async function resolveCardBranch(vault: VaultStore, card: CardRec): Promise<string | undefined> {
  if (typeof card.branch === "string" && card.branch) return card.branch;
  for (const sid of cardSessionIds(card)) {
    const s = await vault.get<{ branch?: string }>("sessions", sid);
    if (typeof s?.branch === "string" && s.branch) return s.branch;
  }
  return undefined;
}

// Enqueue a completed card for integration. Idempotent (one entry per card) and
// a no-op for a card with nothing to integrate (no isolated branch).
export async function enqueueOnComplete(vault: VaultStore, cardId: string): Promise<void> {
  const card = await vault.get<CardRec>("cards", cardId);
  if (!card || card.state !== "complete") return;
  const branch = await resolveCardBranch(vault, card);
  if (!branch) return;
  const existing = await vault.get<MergeQueueEntry>(MERGE_QUEUE_NS, cardId);
  if (existing) return;
  const entry: MergeQueueEntry = {
    cardId,
    projectId: card.projectId ?? "",
    branch,
    enqueuedAt: card.completedAt ?? 0,
    status: "queued",
  };
  await vault.set(MERGE_QUEUE_NS, cardId, entry);
}

// All still-queued entries for a project, FIFO by enqueuedAt (completion order).
export async function readReadyQueue(
  vault: VaultStore,
  projectId: string,
): Promise<MergeQueueEntry[]> {
  const keys = await vault.list(MERGE_QUEUE_NS);
  const entries = await Promise.all(keys.map((k) => vault.get<MergeQueueEntry>(MERGE_QUEUE_NS, k)));
  return entries
    .filter((e): e is MergeQueueEntry => !!e && e.status === "queued" && e.projectId === projectId)
    .sort((a, b) => a.enqueuedAt - b.enqueuedAt);
}

async function setEntry(
  vault: VaultStore,
  entry: MergeQueueEntry,
  patch: Partial<MergeQueueEntry>,
): Promise<void> {
  await vault.set(MERGE_QUEUE_NS, entry.cardId, { ...entry, ...patch });
}

async function loadIntents(vault: VaultStore, byBranch: Map<string, string>): Promise<IntentRef[]> {
  const out: IntentRef[] = [];
  for (const [cardId, branch] of byBranch) {
    const card = await vault.get<CardRec>("cards", cardId);
    out.push(intentOf(card, branch, cardId));
  }
  return out;
}

// --- Escalation --------------------------------------------------------------

async function escalate(
  vault: VaultStore,
  cardId: string,
  block: IntegrationBlock,
  mergeStatus: "blocked-intent" | "blocked-unverifiable",
): Promise<void> {
  const card = await vault.get<CardRec>("cards", cardId);
  if (!card) return;
  await vault.set("cards", cardId, {
    ...card,
    state: "blocked",
    mergeStatus,
    integrationBlock: block,
  });
}

// --- The drain loop ----------------------------------------------------------

export async function drain(deps: CoordinatorDeps, projectId: string): Promise<void> {
  const plan = await deps.plan(projectId);
  const handle = await deps.git.ensureIntegrationWorktree({
    repo: plan.repo,
    integrationRoot: plan.integrationRoot,
    base: plan.base,
  });

  let tip = handle.tip;
  // file path -> [cardId,...] for every branch already applied this drain, so a
  // later conflict can be attributed to the sibling(s) that own the hunks.
  const fileOwners = new Map<string, string[]>();
  const branchOf = new Map<string, string>(); // cardId -> branch, for contributor intent
  const merged: string[] = [];

  for (const entry of await readReadyQueue(deps.vault, projectId)) {
    await setEntry(deps.vault, entry, { status: "merging" });
    const priorTip = tip;
    const card = await deps.vault.get<CardRec>("cards", entry.cardId);
    const preview = await deps.git.previewMerge(handle.workdir, INTEGRATION_BRANCH, entry.branch);

    let mergeKind: "clean" | "stacked" | "resolved";
    if (preview.clean) {
      tip = await deps.git.applyClean(handle.workdir, entry.branch, `merge ${entry.cardId}`);
      mergeKind = "clean";
    } else {
      // Textual conflict. Before treating it as a collision, try to STACK
      // (waterfall): replay this branch's commits atop the already-integrated
      // siblings. A clean patch series means the work was dependent/compatible —
      // it sits on top, not against. The gate below still verifies the result.
      const stack = await deps.git.stackOnto(handle.workdir, plan.base, entry.branch);
      if (stack.clean) {
        tip = stack.tip;
        mergeKind = "stacked";
      } else {
        // Genuine independent overlap — hand to the intent-aware resolver, with the
        // already-integrated siblings that own the conflicted hunks as context.
        const contributorIds = uniq(preview.conflictFiles.flatMap((f) => fileOwners.get(f) ?? []));
        const contributors = await loadIntents(
          deps.vault,
          new Map(contributorIds.map((id) => [id, branchOf.get(id) ?? ""])),
        );
        const outcome = await deps.resolver({
          integrationWorkdir: handle.workdir,
          incoming: intentOf(card, entry.branch, entry.cardId),
          contributors,
          conflictFiles: preview.conflictFiles,
        });
        if (outcome.kind === "intent-conflict") {
          await escalate(
            deps.vault,
            entry.cardId,
            {
              kind: "intent",
              question: outcome.question,
              options: outcome.options,
              otherCardIds: contributorIds,
            },
            "blocked-intent",
          );
          await setEntry(deps.vault, entry, { status: "escalated", result: "intent-conflict" });
          await deps.git.resetIntegration(handle.workdir, priorTip);
          continue;
        }
        if (outcome.kind === "unverifiable") {
          await escalate(
            deps.vault,
            entry.cardId,
            { kind: "unverifiable", question: outcome.question },
            "blocked-unverifiable",
          );
          await setEntry(deps.vault, entry, { status: "escalated", result: "unverifiable" });
          await deps.git.resetIntegration(handle.workdir, priorTip);
          continue;
        }
        // resolved: the resolver agent committed its reconciliation in the worktree
        tip = await deps.git.currentTip(handle.workdir);
        mergeKind = "resolved";
      }
    }

    // Gate the combined state after each apply so the culprit is identifiable.
    // No verify command configured => no semantic gate (textual merge only):
    // the project hasn't told us how to test it, so we don't pretend to.
    const gate = plan.verify ? await deps.gate(handle.workdir, plan.verify) : { green: true, output: "" };
    if (!gate.green) {
      await escalate(
        deps.vault,
        entry.cardId,
        {
          kind: "unverifiable",
          question: "The combined build/test gate failed and could not be auto-fixed.",
        },
        "blocked-unverifiable",
      );
      await setEntry(deps.vault, entry, { status: "escalated", result: "unverifiable", error: gate.output.slice(0, 2000) });
      await deps.git.resetIntegration(handle.workdir, priorTip);
      tip = priorTip;
      continue;
    }

    // Green: this branch is in. Record attribution and mark the card merged.
    for (const f of await deps.git.changedFiles(handle.workdir, plan.base, entry.branch)) {
      fileOwners.set(f, [...(fileOwners.get(f) ?? []), entry.cardId]);
    }
    branchOf.set(entry.cardId, entry.branch);
    merged.push(entry.cardId);
    await setEntry(deps.vault, entry, {
      status: "merged",
      result: mergeKind,
      integrationTip: tip,
    });
    if (card) {
      await deps.vault.set("cards", entry.cardId, { ...card, mergeStatus: "merged", mergedAt: entry.enqueuedAt });
    }
  }

  if (merged.length > 0) {
    await deps.terminalStep({ handle, projectId, mode: plan.mode, mergedCardIds: merged, plan });
  }
}

// Resume after the user answers an escalation. Triggered when a blocked card's
// integrationBlock gains a `chosen` winner (a chip click) — see the web resolve
// path. For an intent decision: every non-winner participant is finalized as
// "goal lost" (its queue entry dropped) and the winner is re-enqueued for
// another drain pass. For unverifiable: the agent presumably updated the branch,
// so just clear the block and re-drain.
//
// LIMITATION (fast mode): if a loser was already fast-forwarded onto main in a
// prior drain, the re-drain will re-conflict and re-escalate rather than auto-
// revert it — safe (never a silent wrong merge), but the revert of already-
// merged work is a deliberate follow-up, not done here.
export async function resumeOnResolve(deps: CoordinatorDeps, cardId: string): Promise<void> {
  const card = await deps.vault.get<CardRec>("cards", cardId);
  const block = card?.integrationBlock as IntegrationBlock | undefined;
  if (!card || card.state !== "blocked" || !block?.chosen) return;
  const projectId = card.projectId ?? "";

  const reenqueue = async (c: CardRec): Promise<void> => {
    const { integrationBlock: _b, ...rest } = c;
    await deps.vault.set("cards", c.id, { ...rest, mergeStatus: "queued" });
    await deps.vault.set(MERGE_QUEUE_NS, c.id, {
      cardId: c.id,
      projectId: c.projectId ?? "",
      branch: c.branch ?? "",
      enqueuedAt: c.completedAt ?? 0,
      status: "queued",
    });
  };

  if (block.kind === "unverifiable") {
    await reenqueue(card);
    await drain(deps, projectId);
    return;
  }

  const winner = block.chosen;
  const participants = uniq([cardId, ...(block.otherCardIds ?? [])]);
  for (const loserId of participants.filter((p) => p !== winner)) {
    const lc = await deps.vault.get<CardRec>("cards", loserId);
    if (lc) {
      const { integrationBlock: _b, ...rest } = lc;
      await deps.vault.set("cards", loserId, {
        ...rest,
        state: "blocked",
        mergeStatus: "blocked-intent",
        integrationNote: `Goal superseded by card ${winner} in an integration decision.`,
      });
    }
    await deps.vault.delete(MERGE_QUEUE_NS, loserId);
  }
  const wc = await deps.vault.get<CardRec>("cards", winner);
  if (wc) await reenqueue(wc);
  await drain(deps, wc?.projectId ?? projectId);
}
