/**
 * Resolves a workflow that `extends` a base into a full WorkflowSpec. A child states
 * only what differs: scalars and agent settings inherit field-by-field, and when the
 * child lists stages those define the pipeline and its order — each stage inheriting
 * any field it omits from the same-id base stage. A child with no stages inherits the
 * base's stages wholesale.
 */
import { DEFAULT_WORKFLOW } from "./default";
import type { AgentSettings, Stage, WorkflowSpec } from "./types";

export type StageOverride = Partial<Stage> & { id: string };

export interface WorkflowOverride
  extends Partial<Omit<WorkflowSpec, "stages">> {
  stages?: StageOverride[];
}

function mergeAgent(
  base: AgentSettings | undefined,
  child: AgentSettings | undefined,
): AgentSettings | undefined {
  if (!base && !child) return undefined;
  return { ...(base ?? {}), ...(child ?? {}) };
}

function mergeStage(child: StageOverride, base?: Stage): Stage {
  return {
    id: child.id,
    label: child.label ?? base?.label ?? child.id,
    role: child.role ?? base?.role ?? "active",
    gates: child.gates ?? base?.gates ?? [],
    onEnter: child.onEnter ?? base?.onEnter ?? [],
    onExit: child.onExit ?? base?.onExit ?? [],
    agent: mergeAgent(base?.agent, child.agent),
    aggregate: child.aggregate ?? base?.aggregate,
  };
}

export function resolveSpec(
  child: WorkflowOverride,
  base: WorkflowSpec = DEFAULT_WORKFLOW,
): WorkflowSpec {
  const stages: Stage[] = child.stages
    ? child.stages.map((cs) => mergeStage(cs, base.stages.find((s) => s.id === cs.id)))
    : base.stages.map((s) => ({ ...s }));

  const resolved: WorkflowSpec = {
    name: child.name ?? base.name,
    stages,
    completion: child.completion ?? base.completion,
    dirtyTree: child.dirtyTree ?? base.dirtyTree,
    learningKinds: child.learningKinds ?? base.learningKinds,
  };

  const extendsRef = child.extends ?? base.extends;
  if (extendsRef !== undefined) resolved.extends = extendsRef;

  const agent = mergeAgent(base.agent, child.agent);
  if (agent !== undefined) resolved.agent = agent;

  return resolved;
}
