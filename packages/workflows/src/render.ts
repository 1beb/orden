/**
 * Render a resolved WorkflowSpec back to readable runbook markdown — the same
 * shape an operator authors. Used by the web Workflows editor (to seed a preset
 * for editing) and the `workflow_render` MCP tool (so an agent can read a
 * workflow back). Pure: no I/O.
 */
import type { Action, Gate, StageRole, Step, StepKind, WorkflowSpec } from "./types";

/**
 * Infer a step's board-projected role from its kind/action/gate. Publishing and
 * lifecycle primitives are terminal; gates wait; mid-work primitives are active;
 * prose is active. The first prose step in a runbook is conventionally initial,
 * but a runbook projects initial onto the same planning lane regardless. Used
 * when authored markdown omits an explicit role.
 */
export function inferStepRole(kind: StepKind, action?: Action, gate?: Gate): StageRole {
  if (kind === "gate") return "waiting";
  if (kind === "primitive") {
    const terminal = new Set<Action>([
      "journal",
      "push",
      "open-pr",
      "merge",
      "reap",
      "propose-learnings",
    ]);
    if (action && terminal.has(action)) return "terminal";
    return "active";
  }
  return "active";
}

function stepTag(step: Step): string {
  if (step.kind === "gate") return `gate: ${step.gate}`;
  if (step.kind === "primitive") return `do: ${step.action}`;
  return "prose";
}

export function renderSpecMarkdown(spec: WorkflowSpec): string {
  const out: string[] = ["---", `name: ${spec.name}`];
  if (spec.description) out.push(`description: ${spec.description}`);
  if (spec.extends) out.push(`extends: ${spec.extends}`);
  out.push("---", "");
  spec.steps.forEach((step, i) => {
    out.push(`${i + 1}. ${stepTag(step)} — ${step.label}`);
    const prose = (step as { prose?: string }).prose;
    if (prose) out.push(`   ${prose}`);
    out.push("");
  });
  return out.join("\n").trimEnd() + "\n";
}
