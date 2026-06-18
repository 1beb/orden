// Resolves the WorkflowSpec a session or project runs under. Source of truth is
// the vault "workflows" namespace:
//   - key `project:<projectId>` -> the name of the workflow that project uses
//   - key `<name>`              -> the stored workflow (a WorkflowOverride that
//                                  `extends` the default; persisted by the compile step)
// A session may carry its own `workflow` field (HOST_OWNED, chosen at session-create);
// that shadows the project default. Resolution is
//   session.workflow ?? project.defaultWorkflow ?? DEFAULT_WORKFLOW
// An unconfigured project, a missing workflow, or a workflow that fails validation
// all fall back to the built-in default, so a broken or absent workflow can never
// break the app — it just behaves as orden does today. The runbook engine is OPT-IN:
// it only drives cards whose resolved workflow is NOT the default (see isDefaultName),
// so default-workflow completion is byte-for-byte unchanged.
import type { VaultStore } from "@orden/host-api";
import {
  DEFAULT_WORKFLOW,
  PRESET_WORKFLOWS,
  resolveSpec,
  validateWorkflow,
  type WorkflowOverride,
  type WorkflowSpec,
} from "@orden/workflows";

export const WORKFLOWS_NS = "workflows";
export const projectWorkflowKey = (projectId: string): string => `project:${projectId}`;
export const DEFAULT_WORKFLOW_NAME = "default";

/** True when the resolved workflow name is the built-in default. */
export function isDefaultName(name: string | undefined): boolean {
  return !name || name === DEFAULT_WORKFLOW_NAME;
}

export async function resolveProjectWorkflow(
  vault: VaultStore,
  projectId: string,
): Promise<WorkflowSpec> {
  const name = await vault.get<string>(WORKFLOWS_NS, projectWorkflowKey(projectId));
  if (!name) return DEFAULT_WORKFLOW;
  return resolveByName(vault, name);
}

/**
 * The workflow name a session resolves to (session.workflow ?? project default),
 * WITHOUT resolving the spec — used to decide whether the engine should drive the
 * card at all. Returns the name (or undefined for the default).
 */
export async function resolveSessionWorkflowName(
  vault: VaultStore,
  sessionId: string,
): Promise<string | undefined> {
  const ses = await vault.get<{ workflow?: string; projectId?: string }>("sessions", sessionId);
  if (ses?.workflow && ses.workflow.trim()) return ses.workflow.trim();
  if (ses?.projectId) {
    const projName = await vault.get<string>(WORKFLOWS_NS, projectWorkflowKey(ses.projectId));
    if (projName) return projName;
  }
  return undefined;
}

/** The resolved WorkflowSpec for a session, falling back to the default. */
export async function resolveSessionWorkflow(
  vault: VaultStore,
  sessionId: string,
): Promise<WorkflowSpec> {
  const name = await resolveSessionWorkflowName(vault, sessionId);
  if (!name) return DEFAULT_WORKFLOW;
  return resolveByName(vault, name);
}

async function resolveByName(vault: VaultStore, name: string): Promise<WorkflowSpec> {
  // Built-in presets are resolved directly (they are not stored in the vault).
  const preset = PRESET_WORKFLOWS.find((w) => w.name === name);
  if (preset) return preset;

  const stored = await vault.get<WorkflowOverride>(WORKFLOWS_NS, name);
  if (!stored) {
    console.warn(
      `orden: references workflow "${name}" which is missing; using default`,
    );
    return DEFAULT_WORKFLOW;
  }
  const resolved = resolveSpec(stored, DEFAULT_WORKFLOW);
  const { errors } = validateWorkflow(resolved);
  if (errors.length > 0) {
    console.warn(
      `orden: workflow "${name}" is invalid (${errors.join("; ")}); using default`,
    );
    return DEFAULT_WORKFLOW;
  }
  return resolved;
}
