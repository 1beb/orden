/**
 * The workflow model — a runbook of typed steps. A WorkflowSpec is the compiled,
 * deterministic form of an operator's prose workflow: the host acts only on these typed
 * primitives, never on the prose. See
 * docs/plans/2026-06-17-configurable-workflows-consolidated.md.
 */

/**
 * The lifecycle lane a step projects onto for the kanban board. Authoring is a runbook;
 * the board is the derived view of the active step's role. Because every runbook projects
 * onto these four roles, one board can show cards running different workflows.
 */
export type StageRole = "initial" | "active" | "waiting" | "terminal";

/** A point that pauses for the operator. */
export type Gate = "approve" | "review";

/** A host effect (deterministic) that a `primitive` step runs. */
export type Action =
  | "journal"
  | "push"
  | "open-pr"
  | "merge"
  | "reap"
  | "propose-learnings"
  | "verify";

export type Harness = "claude" | "opencode";
export type SessionMode = "tui" | "gui";

/** In-session agent behavior, for the whole workflow or one prose step. */
export interface AgentSettings {
  harness?: Harness;
  isolate?: boolean;
  mode?: SessionMode;
  /** The destructive-git denial; only bites in a shared (non-isolated) checkout. */
  gitGuard?: boolean;
  /**
   * Models to run a prose step with. Absent or empty = the harness default. One entry =
   * a single model. More than one = the step fans out, one parallel attempt per model,
   * and the step's `aggregate` reconciles them into a single result. The fan-out stays
   * inside one step, so the runbook remains linear.
   */
  models?: string[];
}

/**
 * The explicit step that reconciles a multi-model prose step's parallel attempts into
 * one result. Only meaningful when the step runs more than one model.
 */
export interface Aggregation {
  /** Model that performs the reconciliation; defaults to the harness default. */
  model?: string;
}

/** How to handle an uncommitted working tree when a step wants to publish. */
export type DirtyTreePolicy = "commit-and-push" | "push-committed" | "ask";

/** The kind of a runbook step. */
export type StepKind = "prose" | "primitive" | "gate";

interface StepBase {
  /** Canonical id (slug of the label); stable across re-renders and merges. */
  id: string;
  /** The operator's display word. */
  label: string;
  /** Which board lane the step projects onto. */
  role: StageRole;
}

/** Drive the agent with instructions — a non-deterministic effect. */
export interface ProseStep extends StepBase {
  kind: "prose";
  /** The agent's instructions for this step. */
  prose: string;
  /** Per-step agent override; falls back to the workflow-wide `agent`. */
  agent?: AgentSettings;
  /** Reconciliation for a multi-model step; see `AgentSettings.models`. */
  aggregate?: Aggregation;
}

/** Run a host effect from the catalog — deterministic. */
export interface PrimitiveStep extends StepBase {
  kind: "primitive";
  action: Action;
  /** Effect parameters (e.g. the command for a future `run` primitive). */
  params?: Record<string, unknown>;
  /** Optional human/agent-facing note. */
  prose?: string;
}

/** A durable pause for the operator. */
export interface GateStep extends StepBase {
  kind: "gate";
  gate: Gate;
  /** Optional human/agent-facing note. */
  prose?: string;
}

export type Step = ProseStep | PrimitiveStep | GateStep;

export interface WorkflowSpec {
  name: string;
  /** Inherit another workflow and override only the differences. */
  extends?: string;
  /** whenToUse — used for agent-suggested selection and the picker. */
  description?: string;
  /** The runbook: an ordered list of typed steps. */
  steps: Step[];
  /** Workflow-wide agent default. */
  agent?: AgentSettings;
  /** How to handle an uncommitted tree at a publishing step. */
  dirtyTree?: DirtyTreePolicy;
  /** Learning kinds in play (readme/adr/agents/skill, extensible). */
  learningKinds?: string[];
}
