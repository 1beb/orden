/**
 * Resolves a workflow that `extends` a base into a full WorkflowSpec runbook. A child
 * states only what differs: scalars and agent settings inherit field-by-field, and when
 * the child lists steps those define the runbook and its order — each step inheriting any
 * field it omits from the same-id base step. A child with no steps inherits the base's
 * steps wholesale.
 */
import { DEFAULT_WORKFLOW } from "./default";
import type {
  Action,
  AgentSettings,
  Aggregation,
  Gate,
  GateStep,
  PrimitiveStep,
  ProseStep,
  Step,
  StepKind,
  Role,
  WorkflowSpec,
} from "./types";

export interface StepOverride {
  id: string;
  kind?: StepKind;
  label?: string;
  role?: Role;
  prose?: string;
  agent?: AgentSettings;
  aggregate?: Aggregation;
  action?: Action;
  params?: Record<string, unknown>;
  gate?: Gate;
}

export interface WorkflowOverride
  extends Partial<Omit<WorkflowSpec, "steps">> {
  steps?: StepOverride[];
}

function mergeAgent(
  base: AgentSettings | undefined,
  child: AgentSettings | undefined,
): AgentSettings | undefined {
  if (!base && !child) return undefined;
  return { ...(base ?? {}), ...(child ?? {}) };
}

function mergeStep(child: StepOverride, base?: Step): Step {
  const kind: StepKind = child.kind ?? base?.kind ?? "prose";
  const id = child.id;
  const label = child.label ?? base?.label ?? child.id;
  const role: Role = child.role ?? base?.role ?? "active";

  if (kind === "prose") {
    const b = base?.kind === "prose" ? (base as ProseStep) : undefined;
    const step: ProseStep = {
      id,
      label,
      role,
      kind: "prose",
      prose: child.prose ?? b?.prose ?? "",
    };
    const agent = mergeAgent(b?.agent, child.agent);
    if (agent !== undefined) step.agent = agent;
    const aggregate = child.aggregate ?? b?.aggregate;
    if (aggregate !== undefined) step.aggregate = aggregate;
    return step;
  }

  if (kind === "primitive") {
    const b = base?.kind === "primitive" ? (base as PrimitiveStep) : undefined;
    const step: PrimitiveStep = {
      id,
      label,
      role,
      kind: "primitive",
      action: (child.action ?? b?.action) as Action,
    };
    const params = child.params ?? b?.params;
    if (params !== undefined) step.params = params;
    const prose = child.prose ?? b?.prose;
    if (prose !== undefined) step.prose = prose;
    return step;
  }

  const b = base?.kind === "gate" ? (base as GateStep) : undefined;
  const step: GateStep = {
    id,
    label,
    role,
    kind: "gate",
    gate: (child.gate ?? b?.gate) as Gate,
  };
  const prose = child.prose ?? b?.prose;
  if (prose !== undefined) step.prose = prose;
  return step;
}

export function resolveSpec(
  child: WorkflowOverride,
  base: WorkflowSpec = DEFAULT_WORKFLOW,
): WorkflowSpec {
  const steps: Step[] = child.steps
    ? child.steps.map((cs) => mergeStep(cs, base.steps.find((s) => s.id === cs.id)))
    : base.steps.map((s) => ({ ...s }));

  const resolved: WorkflowSpec = {
    name: child.name ?? base.name,
    steps,
    dirtyTree: child.dirtyTree ?? base.dirtyTree,
    learningKinds: child.learningKinds ?? base.learningKinds,
  };

  const description = child.description ?? base.description;
  if (description !== undefined) resolved.description = description;
  const extendsRef = child.extends ?? base.extends;
  if (extendsRef !== undefined) resolved.extends = extendsRef;
  const agent = mergeAgent(base.agent, child.agent);
  if (agent !== undefined) resolved.agent = agent;

  return resolved;
}
