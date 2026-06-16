/**
 * The workflow model. A WorkflowSpec is the compiled, deterministic form of an
 * operator's prose workflow: the host acts only on these typed primitives, never
 * on the prose. See docs/plans/2026-06-16-configurable-workflows-design.md.
 */

/** The role a stage plays in the lifecycle, independent of its display label. */
export type StageRole = "initial" | "active" | "waiting" | "terminal";

/** A point that pauses for the operator. */
export type Gate = "approve" | "review";

/** A side-effect that fires on entering/leaving a stage. */
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

/** In-session agent behavior, for the whole workflow or one stage. */
export interface AgentSettings {
  harness?: Harness;
  isolate?: boolean;
  mode?: SessionMode;
  /** The destructive-git denial; only bites in a shared (non-isolated) checkout. */
  gitGuard?: boolean;
}

/** What the terminal stage produces. */
export type CompletionOutput = "none" | "push" | "push+pr" | "push+merge";

/** How to handle an uncommitted working tree when a stage wants to publish. */
export type DirtyTreePolicy = "commit-and-push" | "push-committed" | "ask";

export interface Stage {
  /** Canonical id (slug of the label); stable across re-renders and merges. */
  id: string;
  /** The operator's display word. */
  label: string;
  role: StageRole;
  gates: Gate[];
  onEnter: Action[];
  onExit: Action[];
  /** Per-stage agent override; falls back to the workflow-wide `agent`. */
  agent?: AgentSettings;
}

export interface WorkflowSpec {
  name: string;
  /** Inherit another workflow and override only the differences. */
  extends?: string;
  stages: Stage[];
  /** Workflow-wide agent default. */
  agent?: AgentSettings;
  /** What the terminal stage produces. */
  completion?: CompletionOutput;
  /** How to handle an uncommitted tree at a publishing step. */
  dirtyTree?: DirtyTreePolicy;
  /** Learning kinds in play (readme/adr/agents/skill, extensible). */
  learningKinds?: string[];
}
