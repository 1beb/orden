// Lifecycle vocabulary — the shared Lane/Role primitives + default config.
// @orden/host-api consumes + re-exports these so downstream never imports this
// package for the lifecycle types. See ./lifecycle.
//
// Type-only re-exports use `export type` so esbuild (tsx) can erase them under
// isolatedModules — mixing them into a value export leaves a dangling import
// of a name the transpiled source no longer provides.
export type {
  Role,
  DefaultLane,
  LaneDef,
  LifecycleConfig,
} from "./lifecycle";
export {
  DEFAULT_LANES,
  COMPLETE_TTL_MS,
  DEFAULT_LIFECYCLE,
} from "./lifecycle";

export type {
  Gate,
  Action,
  Harness,
  SessionMode,
  AgentSettings,
  Aggregation,
  DirtyTreePolicy,
  StepKind,
  ProseStep,
  PrimitiveStep,
  GateStep,
  Step,
  WorkflowSpec,
} from "./types";
export {
  ROLES,
  GATES,
  ACTIONS,
  IRREVERSIBLE_ACTIONS,
  isRole,
  isGate,
  isAction,
} from "./catalog";
export { DEFAULT_WORKFLOW } from "./default";
export { PRESET_WORKFLOWS } from "./presets";
export { parseWorkflowMarkdown } from "./parse";
export type { ParsedStage, ParsedWorkflow } from "./parse";
export { validateWorkflow } from "./validate";
export type { ValidationResult } from "./validate";
export { resolveSpec } from "./resolve";
export type { StepOverride, WorkflowOverride } from "./resolve";
