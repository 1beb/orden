// Resolves the WorkflowSpec a project runs under. Source of truth is the vault
// "workflows" namespace:
//   - key `project:<projectId>` -> the name of the workflow that project uses
//   - key `<name>`              -> the stored workflow (a WorkflowOverride that
//                                  `extends` the default; persisted by the compile step)
// An unconfigured project, a missing workflow, or a workflow that fails validation all
// fall back to the built-in default, so a broken or absent workflow can never break the
// app — it just behaves as orden does today.
import type { VaultStore } from "@orden/host-api";
import {
  DEFAULT_WORKFLOW,
  resolveSpec,
  validateWorkflow,
  type WorkflowOverride,
  type WorkflowSpec,
} from "@orden/workflows";

export const WORKFLOWS_NS = "workflows";
export const projectWorkflowKey = (projectId: string): string => `project:${projectId}`;

export async function resolveProjectWorkflow(
  vault: VaultStore,
  projectId: string,
): Promise<WorkflowSpec> {
  const name = await vault.get<string>(WORKFLOWS_NS, projectWorkflowKey(projectId));
  if (!name) return DEFAULT_WORKFLOW;

  const stored = await vault.get<WorkflowOverride>(WORKFLOWS_NS, name);
  if (!stored) {
    console.warn(
      `orden: project ${projectId} references workflow "${name}" which is missing; using default`,
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
