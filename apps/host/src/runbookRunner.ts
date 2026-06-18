// The host-side runbook runner: the impure orchestration over the pure engine.
// It loads a card's run-state, executes primitive steps via the executor
// dispatch, parks gates as durable vault suspensions, projects the card's column
// from the active step's role, and applies the dirty-state rule. The pure
// control-flow decisions live in @orden/workflows/engine; this module is the
// hands.
//
// OPT-IN: the runner only drives cards whose resolved workflow is NOT the
// default. A default-workflow card is never touched here, so its completion is
// byte-for-byte unchanged (the existing serve.ts reactors fire as today). This
// is the behavior-neutrality guarantee.
//
// Signals: the runner generates pass/fail itself for primitives. The operator
// drives gates (approve/reject) and prose completion via a vault write to the
// workflow-signal namespace, which the host change-feed routes here.

import type { Host } from "@orden/host-api";
import { type CardRec, cardSessionIds, logCardCompletion } from "@orden/mcp";
import {
  advance,
  activeStep,
  gateKey,
  initialRunState,
  projectColumn,
  type AdvanceSignal,
  type GateDecision,
  type RunState,
  type StepOutcome,
  type WorkflowSpec,
} from "@orden/workflows";
import { isDefaultName, resolveSessionWorkflowName, resolveSessionWorkflow } from "./workflowResolver";
import { enqueueOnComplete } from "./mergeCoordinator";
import { defaultGitExec } from "./worktrees";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const WORKFLOW_RUN_NS = "workflow-run";
export const WORKFLOW_SIGNAL_NS = "workflow-signal";
const WORKFLOW_GATE_DECISION_NS = "workflow-gate";

/** Injected command runner for `run`/`check` primitives + the dirty-state check. */
export interface RunnerDeps {
  /** Run a shell command in a cwd; returns exit code + stdout. */
  runCommand?: (cwd: string, command: string) => Promise<{ code: number; stdout: string }>;
  /** git status --porcelain in a workdir; empty stdout = clean. */
  gitStatus?: (workdir: string) => Promise<{ code: number; stdout: string }>;
  /** Override the executor dispatch (tests stub the effects). */
  executePrimitive?: (
    host: Host,
    card: CardRec,
    sessionIds: string[],
    workdirs: string[],
    spec: WorkflowSpec,
    run: RunState,
  ) => Promise<StepOutcome>;
  /** Append a line to the card's log page (notify/capture evidence). */
  logLine?: (cardId: string, line: string) => Promise<void>;
  /** Now (testable). */
  now?: () => number;
}

const baseDeps = {
  runCommand: async (): Promise<{ code: number; stdout: string }> => ({ code: 0, stdout: "" }),
  gitStatus: async (): Promise<{ code: number; stdout: string }> => ({ code: 0, stdout: "" }),
  logLine: async (_cardId: string, _line: string): Promise<void> => {},
  now: (): number => Date.now(),
};

/** Merge caller deps over the defaults; the default executor closes over the MERGED deps. */
function buildDeps(d?: RunnerDeps): Required<RunnerDeps> {
  const merged: Required<RunnerDeps> = {
    runCommand: d?.runCommand ?? baseDeps.runCommand,
    gitStatus: d?.gitStatus ?? baseDeps.gitStatus,
    logLine: d?.logLine ?? baseDeps.logLine,
    now: d?.now ?? baseDeps.now,
    executePrimitive:
      d?.executePrimitive ??
      (async (host, card, sids, wds, spec, run) =>
        executePrimitiveAction(host, card, sids, wds, spec, run, merged)),
  };
  return merged;
}

/** Load (or initialize) the durable run-state for a card. */
async function loadRunState(
  vault: Host["vault"],
  cardId: string,
  workflowName: string,
): Promise<RunState> {
  const existing = await vault.get<RunState>(WORKFLOW_RUN_NS, cardId);
  if (existing && typeof existing.stepIndex === "number") return existing;
  return initialRunState(cardId, workflowName);
}

/** The workdirs of a card's linked sessions (where commands run). */
async function sessionWorkdirs(host: Host, sessionIds: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const sid of sessionIds) {
    const ses = await host.vault.get<{ workdir?: string }>("sessions", sid);
    if (typeof ses?.workdir === "string" && ses.workdir) out.push(ses.workdir);
  }
  return out;
}

/**
 * Advance a card's runbook one tick: execute any runnable primitive steps until
 * the run reaches a stable point (a gate park, a dirty park, done, or a prose
 * step the agent must work). Idempotent — safe to call on every relevant vault
 * change. No-ops for default-workflow cards (the opt-in gate).
 */
export async function tickRunbook(host: Host, cardId: string, d?: RunnerDeps): Promise<void> {
  const card = await host.vault.get<CardRec>("cards", cardId);
  if (!card) return;
  const sessionIds = cardSessionIds(card);
  if (sessionIds.length === 0) return;

  // OPT-IN: only non-default workflows are engine-driven.
  const wfName = await resolveSessionWorkflowName(host.vault, sessionIds[0]);
  if (isDefaultName(wfName)) return;
  const spec = await resolveSessionWorkflow(host.vault, sessionIds[0]);
  if (!spec || spec.name === "default") return;

  const dd = buildDeps(d);
  let run = await loadRunState(host.vault, cardId, spec.name);

  // Bound the loop: a tick advances through consecutive runnable primitives but
  // stops at a gate, a prose step, a dirty park, or completion.
  for (let guard = 0; guard < 64; guard++) {
    if (run.status === "done") {
      await setCardColumn(host, card, "complete");
      await host.vault.set(WORKFLOW_RUN_NS, cardId, run);
      return;
    }
    if (run.status === "gate-parked" || run.status === "parked-dirty") {
      await setCardColumn(host, card, "blocked");
      await host.vault.set(WORKFLOW_RUN_NS, cardId, run);
      return;
    }

    const step = activeStep(spec, run);
    if (!step) {
      run = { ...run, status: "done" };
      continue;
    }

    // Project the active step's role onto the card column.
    await setCardColumn(host, card, projectColumn(run, spec));

    if (step.kind === "prose") {
      // The agent is the effect; the runner just projects and waits for a
      // completion signal from the operator/agent.
      await host.vault.set(WORKFLOW_RUN_NS, cardId, run);
      return;
    }

    if (step.kind === "gate") {
      // Park as a durable vault suspension: the operator's decision is the
      // resume signal (written to the gate-decision namespace).
      run = { ...run, status: "gate-parked" };
      await setCardColumn(host, card, "blocked");
      await host.vault.set(WORKFLOW_RUN_NS, cardId, run);
      return;
    }

    // primitive step — dirty-state gate before publishing effects.
    const action = step.action;
    if (action === "push" || action === "open-pr" || action === "merge") {
      const dirty = await isTreeDirty(host, sessionIds, dd);
      const policy = spec.dirtyTree ?? "ask";
      if (dirty && policy === "ask") {
        // Park directly: publishing actions aren't gating primitives, so the
        // engine's advance() would ignore a "fail" — the dirty precondition is a
        // host-level decision not to run the step at all.
        run = {
          ...run,
          status: "parked-dirty",
          parkedReason: `Cannot ${action}: working tree has uncommitted changes.`,
          history: [...run.history, { stepId: step.id, outcome: "fail", at: dd.now() }],
        };
        await host.vault.set(WORKFLOW_RUN_NS, cardId, run);
        continue;
      }
    }

    // Execute and advance.
    const wds = await sessionWorkdirs(host, sessionIds);
    const outcome = await dd.executePrimitive(host, card, sessionIds, wds, spec, run);
    run = advance(spec, run, outcome, dd.now());
    await host.vault.set(WORKFLOW_RUN_NS, cardId, run);
  }
}

/**
 * Process an operator/agent signal for a card's current step (a gate decision
 * or a prose-step completion). Advances the run, then ticks.
 */
export async function handleSignal(
  host: Host,
  cardId: string,
  signal: AdvanceSignal,
  d?: RunnerDeps,
): Promise<void> {
  const dd = buildDeps(d);
  const sessionIds = await cardSessionIdsFor(host, cardId);
  if (sessionIds.length === 0) return;
  const wfName = await resolveSessionWorkflowName(host.vault, sessionIds[0]);
  if (isDefaultName(wfName)) return;
  const spec = await resolveSessionWorkflow(host.vault, sessionIds[0]);
  if (!spec || spec.name === "default") return;

  let run = await loadRunState(host.vault, cardId, spec.name);
  run = advance(spec, run, signal, dd.now());
  await host.vault.set(WORKFLOW_RUN_NS, cardId, run);
  await tickRunbook(host, cardId, d);
}

async function cardSessionIdsFor(host: Host, cardId: string): Promise<string[]> {
  const card = await host.vault.get<CardRec>("cards", cardId);
  return card ? cardSessionIds(card) : [];
}

async function isTreeDirty(host: Host, sessionIds: string[], dd: Required<RunnerDeps>): Promise<boolean> {
  for (const sid of sessionIds) {
    const ses = await host.vault.get<{ workdir?: string }>("sessions", sid);
    if (typeof ses?.workdir === "string" && ses.workdir) {
      const st = await dd.gitStatus(ses.workdir);
      if (st.code === 0 && st.stdout.trim() !== "") return true;
    }
  }
  return false;
}

// Only write the card state when it actually changes, to avoid a feedback loop
// (the card write re-fires the reactor that called tick).
async function setCardColumn(host: Host, card: CardRec, column: string): Promise<void> {
  if (card.state === column) return;
  // "complete" is terminal and user-owned under the default runbook; for an
  // engine-driven card the engine owns the lifecycle, so it may set complete.
  await host.vault.set("cards", card.id, { ...card, state: column });
}

/**
 * The default executor dispatch: maps a primitive action to its host effect.
 * Extracted so tests can inject a fake; the host wiring passes the real one.
 * Returns the step outcome (pass/fail); non-gating actions always pass.
 */
export async function executePrimitiveAction(
  host: Host,
  card: CardRec,
  sessionIds: string[],
  workdirs: string[],
  spec: WorkflowSpec,
  run: RunState,
  dd: Required<RunnerDeps>,
): Promise<StepOutcome> {
  const step = activeStep(spec, run);
  if (!step || step.kind !== "primitive") return "pass";
  const action = step.action;
  const vault = host.vault;

  switch (action) {
    case "journal": {
      await logCardCompletion(vault, { ...card, state: "complete" });
      return "pass";
    }
    case "push":
    case "open-pr": {
      if (!host.publish) return "pass";
      let worst: StepOutcome = "pass";
      for (const sid of sessionIds) {
        const r = await host.publish(sid, {
          title: card.title,
          summary: typeof card.completionSummary === "string" ? card.completionSummary : undefined,
        });
        if (r.state === "push-failed") worst = "fail";
      }
      return worst;
    }
    case "reap": {
      for (const sid of sessionIds) {
        await host.sessions.kill(sid);
      }
      return "pass";
    }
    case "merge": {
      await enqueueOnComplete(vault, card.id);
      return "pass";
    }
    case "run":
    case "check": {
      const cmd = typeof step.params?.command === "string" ? step.params.command : "";
      if (!cmd) return "pass";
      const cwd = workdirs[0] ?? process.cwd();
      const r = await dd.runCommand(cwd, String(cmd));
      if (action === "run") return "pass"; // run captures, never gates
      // check: gate on exit code (0 = pass).
      return r.code === 0 ? "pass" : "fail";
    }
    case "capture": {
      const cmd = typeof step.params?.command === "string" ? step.params.command : "";
      if (cmd) {
        const cwd = workdirs[0] ?? process.cwd();
        const r = await dd.runCommand(cwd, String(cmd));
        await dd.logLine(card.id, `capture (${cmd}): exit ${r.code}`);
      }
      return "pass";
    }
    case "notify": {
      const msg = typeof step.params?.message === "string" ? step.params.message : step.label;
      await dd.logLine(card.id, `notify: ${msg}`);
      return "pass";
    }
    case "propose-learnings":
    case "code-review":
    case "verify":
      // Agent-driven effects: the in-session agent performs these in its turn.
      // The runner passes through; a following review gate is the human checkpoint.
      return "pass";
    default:
      return "pass";
  }
}

/** The gate-decision vault key an operator's approve/reject lands on. */
export function gateDecisionKey(cardId: string, stepId: string): string {
  return gateKey(cardId, stepId);
}

/**
 * True when a card has a runbook run-state — i.e. the engine is driving it (a
 * non-default workflow is bound). The unconditional completion reactors
 * (reap/publish/journal) call this to DEFER for engine-driven cards: the
 * runner's terminal steps invoke those same effects, so the reactors must not
 * double-fire. A default-workflow card never has a run-state, so the reactors
 * fire exactly as before (the behavior-neutrality guarantee).
 */
export async function isEngineDrivenCard(vault: Host["vault"], cardId: string): Promise<boolean> {
  const run = await vault.get<RunState>(WORKFLOW_RUN_NS, cardId);
  return !!run && typeof (run as RunState).stepIndex === "number";
}

export { WORKFLOW_GATE_DECISION_NS };

/**
 * The real host runner deps: git status via the shared git exec, and a shell
 * command runner for `run`/`check` primitives. Used by the serve.ts wiring;
 * tests inject fakes instead.
 */
export function hostRunnerDeps(extra?: {
  logLine?: (cardId: string, line: string) => Promise<void>;
}): RunnerDeps {
  return {
    gitStatus: async (workdir) => defaultGitExec(workdir, ["status", "--porcelain"]),
    runCommand: async (cwd, command) => {
      try {
        const { stdout } = await execFileAsync("sh", ["-c", command], {
          cwd,
          timeout: 300_000,
          maxBuffer: 10 * 1024 * 1024,
        });
        return { code: 0, stdout };
      } catch (err) {
        const e = err as { code?: number; stdout?: string; stderr?: string };
        return {
          code: typeof e.code === "number" ? e.code : 1,
          stdout: [e.stdout, e.stderr].filter(Boolean).join("\n") || String(err),
        };
      }
    },
    logLine: extra?.logLine,
  };
}
export type { GateDecision };
