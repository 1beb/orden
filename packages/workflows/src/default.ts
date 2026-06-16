/**
 * The built-in `default` workflow: reproduces orden's current hard-coded behavior
 * exactly, so existing projects are unchanged until an operator opts into something
 * else. Every other workflow inherits from this unless it overrides a field.
 */
import type { WorkflowSpec } from "./types";

export const DEFAULT_WORKFLOW: WorkflowSpec = {
  name: "default",
  stages: [
    {
      id: "planning",
      label: "Planning",
      role: "initial",
      gates: ["approve"],
      onEnter: [],
      onExit: [],
    },
    {
      id: "in-progress",
      label: "In-progress",
      role: "active",
      gates: [],
      onEnter: [],
      onExit: [],
    },
    {
      id: "blocked",
      label: "Blocked",
      role: "waiting",
      gates: [],
      onEnter: [],
      onExit: [],
    },
    {
      id: "complete",
      label: "Complete",
      role: "terminal",
      gates: ["review"],
      onEnter: ["journal", "push", "open-pr", "reap", "propose-learnings"],
      onExit: [],
    },
  ],
  agent: { harness: "claude", isolate: true, mode: "tui", gitGuard: true },
  completion: "push+pr",
  dirtyTree: "ask",
  learningKinds: ["readme", "adr", "agents", "skill"],
};
