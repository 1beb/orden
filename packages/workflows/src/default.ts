/**
 * The built-in `default` workflow as a runbook: reproduces orden's current hard-coded
 * behavior exactly (plan, approve, work isolated, review evidence, then propose
 * learnings + journal + push + open-PR + reap; never merge), so existing projects are
 * unchanged until an operator opts into something else. Every other workflow inherits
 * from this unless it overrides a step or field.
 */
import type { WorkflowSpec } from "./types";

export const DEFAULT_WORKFLOW: WorkflowSpec = {
  name: "default",
  description:
    "orden's standard plan/approve/implement/review/publish loop for a code change on its own branch.",
  steps: [
    {
      id: "plan",
      label: "Plan",
      role: "initial",
      kind: "prose",
      prose: "Write a short plan as a doc and park it for me.",
    },
    {
      id: "approve-the-plan",
      label: "Approve the plan",
      role: "waiting",
      kind: "gate",
      gate: "approve",
      prose: "I review the parked plan and approve before any code is written.",
    },
    {
      id: "implement",
      label: "Implement",
      role: "active",
      kind: "prose",
      prose:
        "Work the plan on your own branch in an isolated worktree. Commit as you go, then render a readable writeup of what changed for me to review.",
    },
    {
      id: "review-the-evidence",
      label: "Review the evidence",
      role: "waiting",
      kind: "gate",
      gate: "review",
      prose: "I read and annotate the writeup; my annotations flow back to you.",
    },
    {
      id: "propose-learnings",
      label: "Propose learnings",
      role: "terminal",
      kind: "primitive",
      action: "propose-learnings",
    },
    { id: "journal", label: "Journal", role: "terminal", kind: "primitive", action: "journal" },
    { id: "push", label: "Push", role: "terminal", kind: "primitive", action: "push" },
    { id: "open-a-pr", label: "Open a PR", role: "terminal", kind: "primitive", action: "open-pr" },
    { id: "reap", label: "Reap", role: "terminal", kind: "primitive", action: "reap" },
  ],
  agent: { harness: "claude", isolate: true, mode: "tui", gitGuard: true },
  dirtyTree: "ask",
  learningKinds: ["readme", "adr", "agents", "skill"],
};
