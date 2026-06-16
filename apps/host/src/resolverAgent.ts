// Conflict resolver for the merge coordinator.
//
// `conservativeResolver` is the safe fallback: it NEVER silently merges a textual
// conflict it can't reason about — every conflict escalates as an intent decision
// so the user picks which card's change wins. `makeNodeResolver` is the real D2
// resolver: it spawns an ephemeral agent in the integration worktree, hands it
// each contributing branch's intent + the conflict, and lets it reconcile (commit),
// declare the goals incompatible, or report it can't verify — reporting its verdict
// via the resolution_report MCP tool, which the host awaits off the change feed.

import type { ResolverRunner, ResolverInput, ResolverOutcome, IntentRef } from "./mergeCoordinator";
import type { VaultStore } from "@orden/host-api";
import { MERGE_RESOLUTION_NS, type ResolutionVerdict } from "@orden/mcp";

/** Minimal shape of a vault change ({ns, key}); avoids coupling to nodeHost. */
interface ChangeKey {
  ns: string;
  key: string;
}

const label = (r: { title?: string; cardId: string }): string => r.title || r.cardId;

export const conservativeResolver: ResolverRunner = async (
  input: ResolverInput,
): Promise<ResolverOutcome> => {
  const others = input.contributors.map(label).join(", ");
  return {
    kind: "intent-conflict",
    question:
      `"${label(input.incoming)}" conflicts with ${others || "earlier work"} in ` +
      `${input.conflictFiles.join(", ")}. Automatic reconciliation isn't enabled yet — ` +
      `which card's goal should win?`,
    // Chip values are card ids (resume matches the chosen winner against them).
    options: [input.incoming.cardId, ...input.contributors.map((c) => c.cardId)],
  };
};

// --- D2: the intent-aware resolver agent ------------------------------------

// True when at least one side carries a plan doc — the intent the resolver agent
// reconciles against. Without ANY intent there's nothing for it to reason about,
// so we fall back to the conservative escalation.
const hasIntent = (input: ResolverInput): boolean =>
  !!input.incoming.planDoc || input.contributors.some((c) => !!c.planDoc);

// The initial prompt handed to the ephemeral resolver agent: both sides' intent,
// the conflict, and the resolution_report protocol it must close with.
export function buildResolverPrompt(input: ResolverInput): string {
  const intent = (r: IntentRef): string =>
    `- "${label(r)}" (branch ${r.branch})` +
    (r.planDoc ? `, plan: ${r.planDoc}` : "") +
    (r.description ? `\n    ${r.description}` : "");
  return [
    `You are an ephemeral merge-conflict resolver running in the orden integration`,
    `worktree at ${input.integrationWorkdir}. Two or more sessions changed overlapping`,
    `code; reconcile them so BOTH goals are preserved. Read each side's plan doc for intent.`,
    ``,
    `Incoming change:`,
    intent(input.incoming),
    `Already-integrated change(s) it conflicts with:`,
    ...input.contributors.map(intent),
    ``,
    `Conflicting files: ${input.conflictFiles.join(", ")}.`,
    ``,
    `Finish by calling the resolution_report MCP tool exactly once:`,
    `- Reconciled both goals: commit it (git add + git commit), then resolution_report({kind:"resolved"}).`,
    `- Goals genuinely contradict (cannot both hold): resolution_report({kind:"intent-conflict", question:"<goal-level question for the user>"}) — do NOT commit.`,
    `- Cannot produce a change that will pass the project's checks: resolution_report({kind:"unverifiable", question:"<why>"}).`,
  ].join("\n");
}

// Map the agent's structured verdict (or null on timeout) to a ResolverOutcome.
// A null or unverifiable verdict is unverifiable; intent-conflict carries the
// card-id chip options the resume path matches a winner against.
export function outcomeFromVerdict(
  verdict: ResolutionVerdict | null,
  input: ResolverInput,
): ResolverOutcome {
  if (!verdict || verdict.kind === "unverifiable") {
    return {
      kind: "unverifiable",
      question: verdict?.question || "The resolver could not produce a verified reconciliation.",
    };
  }
  if (verdict.kind === "intent-conflict") {
    return {
      kind: "intent-conflict",
      question: verdict.question || `"${label(input.incoming)}" conflicts with earlier work — which goal wins?`,
      options: [input.incoming.cardId, ...input.contributors.map((c) => c.cardId)],
    };
  }
  return { kind: "resolved" };
}

// The host-side surface the node resolver drives: spawn an ephemeral resolver
// session in a cwd, await its verdict, reap it. Injected so the orchestration is
// unit-tested without real agents.
export interface ResolverSpawn {
  spawn(input: { cwd: string; prompt: string; projectId?: string }): Promise<string>;
  awaitVerdict(sessionId: string): Promise<ResolutionVerdict | null>;
  reap(sessionId: string): Promise<void>;
}

// The real D2 resolver. Falls back to `fallback` (conservative) when there's no
// intent to reason about; otherwise spawns the agent, maps its verdict, and ALWAYS
// reaps the ephemeral session.
export function makeNodeResolver(spawn: ResolverSpawn, fallback: ResolverRunner): ResolverRunner {
  return async (input: ResolverInput): Promise<ResolverOutcome> => {
    if (!hasIntent(input)) return fallback(input);
    const sessionId = await spawn.spawn({
      cwd: input.integrationWorkdir,
      prompt: buildResolverPrompt(input),
      projectId: input.projectId,
    });
    try {
      const verdict = await spawn.awaitVerdict(sessionId);
      return outcomeFromVerdict(verdict, input);
    } finally {
      await spawn.reap(sessionId);
    }
  };
}

export interface VerdictWatchDeps {
  vault: Pick<VaultStore, "get">;
  onChange: (cb: (c: ChangeKey) => void) => () => void;
}

// Await a resolver's verdict on the vault change feed: resolve as soon as the
// resolution_report tool writes MERGE_RESOLUTION_NS/<sessionId>, or null on timeout.
// Checks for an already-present verdict first (it can land before we subscribe).
export async function awaitVerdictFromVault(
  deps: VerdictWatchDeps,
  sessionId: string,
  timeoutMs: number,
): Promise<ResolutionVerdict | null> {
  const read = (): Promise<ResolutionVerdict | null> =>
    deps.vault.get<ResolutionVerdict>(MERGE_RESOLUTION_NS, sessionId);
  const present = await read();
  if (present) return present;
  return new Promise<ResolutionVerdict | null>((resolve) => {
    let done = false;
    const finish = (v: ResolutionVerdict | null): void => {
      if (done) return;
      done = true;
      unsub();
      clearTimeout(timer);
      resolve(v);
    };
    const unsub = deps.onChange((c) => {
      if (c.ns === MERGE_RESOLUTION_NS && c.key === sessionId) {
        void read().then((v) => finish(v ?? null));
      }
    });
    const timer = setTimeout(() => finish(null), timeoutMs);
  });
}
